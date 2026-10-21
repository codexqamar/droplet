import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError } from "../auth.js";
import { sha256Hex } from "../lib/crypto.js";
import { mintToken } from "../lib/signedToken.js";
import { verifyPassword, verifyTotp } from "../lib/mfa.js";
import { sendMail } from "../mail.js";
import { applySecurityEvent, issueRecoveryEmails } from "../security/tripwire.js";
import { signedDownloadUrl } from "./desktop.js";

/**
 * Incident recovery. Sessions are revoked during a lock, so these endpoints authenticate with
 * three independent factors: emailed one-time token + password + TOTP.
 */
export async function recoveryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/security/recovery/redeem", async (req) => {
    const body = z
      .object({
        token: z.string().min(20),
        password: z.string().min(1),
        mfaCode: z.string(),
        platform: z.enum(["win-x64", "macos-arm64", "macos-x64"]).default("win-x64"),
      })
      .parse(req.body);

    const outcome = await prisma.$transaction(async (tx) => {
      const rt = await tx.recoveryToken.findUnique({
        where: { tokenHash: sha256Hex(body.token) },
        include: { incident: true },
      });
      // One generic error for every failure mode: no oracle for token validity.
      const fail = () => new HttpError(401, "RECOVERY_FAILED");
      if (!rt || rt.redeemedAt || rt.expiresAt < new Date() || rt.incident.resolvedAt) throw fail();

      const user = await tx.user.findUniqueOrThrow({ where: { id: rt.userId } });
      if (!(await verifyPassword(user.passwordHash, body.password))) throw fail();
      if (!(await verifyTotp(tx, user.id, body.mfaCode))) throw fail();

      await tx.recoveryToken.update({ where: { id: rt.id }, data: { redeemedAt: new Date() } });
      // Burn sibling tokens sent to other account owners.
      await tx.recoveryToken.updateMany({
        where: { incidentId: rt.incidentId, redeemedAt: null },
        data: { expiresAt: new Date() },
      });

      const accountId = rt.incident.tradeAccountId;
      const ctx = { actorId: user.id, ip: req.ip, platform: body.platform };
      await applySecurityEvent(tx, accountId, { type: "RECOVERY_REDEEMED", incidentId: rt.incidentId, userId: user.id, mfaVerified: true }, ctx);
      const issued = await applySecurityEvent(tx, accountId, { type: "CLEAN_BUILD_ISSUED", incidentId: rt.incidentId, releaseId: "latest" }, ctx);
      return { userId: user.id, grantId: issued.downloadGrantId! };
    }, { isolationLevel: "Serializable" });

    const grant = await prisma.downloadGrant.findUniqueOrThrow({ where: { id: outcome.grantId }, include: { release: true } });
    return {
      state: "AWAITING_CLEAN_INSTALL",
      download: { url: signedDownloadUrl(grant.id), sha256: grant.release.artifactSha256, version: grant.release.version },
      enrollmentCode: mintToken("enroll", { userId: outcome.userId, grantId: grant.id }, config.downloadGrantTtlSec),
      instructions: [
        "Uninstall the existing DROPLET desktop app from the affected machine.",
        "Run a malware scan on that machine.",
        "Install the new build and sign in with the enrollment code shown here.",
      ],
    };
  });

  /** Lock-screen "resend email". Always 202 so the endpoint cannot enumerate accounts. */
  app.post("/v1/security/recovery/resend", async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email }, include: { tradeAccount: true } });
    const acct = user?.tradeAccount;
    if (user?.isAccountOwner && acct && (acct.securityState === "LOCKED_TAMPER" || acct.securityState === "RECOVERY_PENDING")) {
      const incident = await prisma.securityIncident.findFirst({
        where: { tradeAccountId: acct.id, resolvedAt: null },
        orderBy: { openedAt: "desc" },
      });
      if (incident) {
        const outbox = await prisma.$transaction(async (tx) => {
          await tx.recoveryToken.updateMany({ where: { incidentId: incident.id, redeemedAt: null }, data: { expiresAt: new Date() } });
          const mails = await issueRecoveryEmails(tx, acct.id, incident.id);
          if (acct.securityState === "LOCKED_TAMPER") {
            await applySecurityEvent(tx, acct.id, { type: "RECOVERY_EMAIL_SENT", incidentId: incident.id });
          }
          return mails;
        });
        await Promise.all(outbox.map(sendMail));
      }
    }
    return reply.status(202).send({ ok: true });
  });
}

/** Cron (every minute): RECOVERY_PENDING accounts whose every token has lapsed fall back to LOCKED_TAMPER. */
export async function sweepExpiredRecoveries(): Promise<number> {
  const pending = await prisma.tradeAccount.findMany({ where: { securityState: "RECOVERY_PENDING" } });
  let swept = 0;
  for (const acct of pending) {
    const incident = await prisma.securityIncident.findFirst({
      where: { tradeAccountId: acct.id, resolvedAt: null },
      orderBy: { openedAt: "desc" },
    });
    if (!incident) continue;
    const live = await prisma.recoveryToken.count({
      where: { incidentId: incident.id, redeemedAt: null, expiresAt: { gt: new Date() } },
    });
    if (live === 0) {
      await prisma.$transaction((tx) => applySecurityEvent(tx, acct.id, { type: "RECOVERY_TOKEN_EXPIRED", incidentId: incident.id }));
      swept++;
    }
  }
  return swept;
}
