import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError } from "../auth.js";
import { safeEqual } from "../lib/crypto.js";

const ReleaseInfo = z.object({
  buildId: z.string().min(3).max(128).regex(/^[A-Za-z0-9.+_-]+$/),
  version: z.string().min(1).max(32),
  platform: z.enum(["win-x64", "macos-arm64", "macos-x64"]),
  manifestRoot: z.string().regex(/^[0-9a-f]{64}$/),
  manifestSig: z.string().min(20).max(200),
});

/**
 * Release publishing for deployed installs. The desktop build (scripts/build.ps1 -RegisterUrl)
 * uploads the signed installer plus its manifest info here, so a new version reaches customers
 * without shell access to the server. Disabled unless DROPLET_OPS_TOKEN is set.
 *
 *   PUT /v1/ops/releases   Authorization: Bearer <DROPLET_OPS_TOKEN>
 *   x-release-info: base64(JSON {buildId, version, platform, manifestRoot, manifestSig})
 *   x-release-filename: DROPLET_<version>_x64-setup.exe
 *   body: the installer bytes (application/octet-stream)
 */
export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: config.maxReleaseBytes }, (_req, body, done) => done(null, body));

  app.put("/v1/ops/releases", { bodyLimit: config.maxReleaseBytes }, async (req) => {
    const auth = req.headers.authorization ?? "";
    if (!config.opsToken || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), config.opsToken)) {
      throw new HttpError(401, "UNAUTHORIZED");
    }
    const rawInfo = req.headers["x-release-info"];
    if (typeof rawInfo !== "string") throw new HttpError(400, "MISSING_RELEASE_INFO");
    const info = ReleaseInfo.parse(JSON.parse(Buffer.from(rawInfo, "base64").toString("utf8")));
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw new HttpError(400, "MISSING_INSTALLER");

    const fileName = String(req.headers["x-release-filename"] ?? "setup.exe").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const artifactKey = `${info.buildId.replace(/[^A-Za-z0-9._-]/g, "_")}-${fileName}`;
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(config.releasesDir, { recursive: true });
    writeFileSync(join(config.releasesDir, artifactKey), bytes);

    const release = await prisma.desktopRelease.upsert({
      where: { buildId: info.buildId },
      create: { ...info, artifactKey, artifactSha256 },
      update: { manifestRoot: info.manifestRoot, manifestSig: info.manifestSig, artifactKey, artifactSha256, revokedAt: null },
    });
    await prisma.auditLog.create({ data: { action: "release.publish", target: release.buildId, meta: { version: info.version, sha256: artifactSha256 }, ip: req.ip } });
    return { buildId: release.buildId, version: release.version, sha256: artifactSha256, bytes: bytes.length };
  });
}
