import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError, requireUser } from "../auth.js";
import { mintToken, readToken } from "../lib/signedToken.js";

/**
 * Object-storage seam. Production: S3/R2 presigned GET with ~60s expiry on a private bucket.
 * The bucket is never public; the only path to an installer is through a DownloadGrant.
 * Development: installers live in apps/cloud-api/releases/ and are served by a signed route below.
 */
export type Presigner = (objectKey: string, ttlSec: number) => Promise<string>;
export const RELEASES_DIR = config.releasesDir;
let presign: Presigner = async (key, ttlSec) =>
  `${config.publicBaseUrl}/v1/desktop/artifact/${encodeURIComponent(mintToken("art", { key }, ttlSec))}`;
export const setPresigner = (p: Presigner): void => {
  presign = p;
};

export function signedDownloadUrl(grantId: string): string {
  const token = mintToken("dl", { grantId }, config.downloadUrlTtlSec);
  return `${config.publicBaseUrl}/v1/desktop/download/${encodeURIComponent(token)}`;
}

export async function desktopRoutes(app: FastifyInstance): Promise<void> {
  /** Portal "Get desktop app" button. Approved, unlocked trade accounts and staff only. */
  app.post("/v1/desktop/download-grants", async (req) => {
    const user = await requireUser(req);
    if (user.role === "TRADE_CUSTOMER" && !(await prisma.mfaFactor.count({ where: { userId: user.id, confirmedAt: { not: null } } }))) {
      // Recovery after a tamper lock needs TOTP, so it must exist before a desktop can be installed.
      throw new HttpError(412, "MFA_REQUIRED");
    }
    const { platform } = z.object({ platform: z.enum(["win-x64", "macos-arm64", "macos-x64"]) }).parse(req.body);
    const release = await prisma.desktopRelease.findFirst({
      where: { platform, revokedAt: null },
      orderBy: { publishedAt: "desc" },
    });
    if (!release) throw new HttpError(404, "NO_RELEASE");
    const grant = await prisma.downloadGrant.create({
      data: {
        userId: user.id,
        releaseId: release.id,
        reason: "ONBOARDING",
        expiresAt: new Date(Date.now() + config.downloadGrantTtlSec * 1000),
      },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, actorRole: user.role, action: "desktop.grant", target: grant.id, ip: req.ip },
    });
    return {
      url: signedDownloadUrl(grant.id),
      sha256: release.artifactSha256,
      version: release.version,
      enrollmentCode: mintToken("enroll", { userId: user.id, grantId: grant.id }, config.enrollmentCodeTtlSec),
      expiresInSec: config.downloadUrlTtlSec,
    };
  });

  /** Redeems a signed, unexpired URL exactly once, then redirects to a short-lived storage URL. */
  app.get<{ Params: { token: string } }>("/v1/desktop/download/:token", async (req, reply) => {
    const claims = readToken<{ grantId: string }>("dl", req.params.token);
    if (!claims || typeof claims.grantId !== "string") throw new HttpError(410, "LINK_EXPIRED");
    const used = await prisma.downloadGrant.updateMany({
      where: { id: claims.grantId, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) throw new HttpError(410, "LINK_EXPIRED");
    const grant = await prisma.downloadGrant.findUniqueOrThrow({ where: { id: claims.grantId }, include: { release: true } });
    await prisma.auditLog.create({
      data: { actorId: grant.userId, action: "desktop.download", target: grant.release.buildId, ip: req.ip },
    });
    return reply.redirect(await presign(grant.release.artifactKey, 60), 302);
  });

  /** Dev stand-in for a presigned object-storage URL. */
  app.get<{ Params: { token: string } }>("/v1/desktop/artifact/:token", async (req, reply) => {
    const claims = readToken<{ key: string }>("art", req.params.token);
    if (!claims) throw new HttpError(410, "LINK_EXPIRED");
    const file = join(RELEASES_DIR, basename(claims.key));
    if (!existsSync(file)) throw new HttpError(404, "ARTIFACT_MISSING");
    void reply.header("content-type", "application/octet-stream");
    void reply.header("content-disposition", `attachment; filename="${basename(claims.key)}"`);
    return reply.send(createReadStream(file));
  });
}
