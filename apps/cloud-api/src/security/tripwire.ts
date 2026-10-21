import type { SecurityState as DbSecurityState } from "@prisma/client";
import { config } from "../config.js";
import { prisma, type Tx } from "../db.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { sendMail, tamperAlertEmail, type OutboundEmail } from "../mail.js";
import { transition, type SecurityEvent, type SecurityState } from "./stateMachine.js";

export interface ApplyResult {
  from: SecurityState;
  next: SecurityState;
  incidentId?: string;
  downloadGrantId?: string;
  outbox: OutboundEmail[];
}

/**
 * Applies one security event to a trade account inside the caller's transaction.
 * Every state change goes through here so the transition table stays the single source of truth.
 */
export async function applySecurityEvent(
  tx: Tx,
  tradeAccountId: string,
  event: SecurityEvent,
  ctx: { actorId?: string; ip?: string; platform?: string } = {},
): Promise<ApplyResult> {
  // Row lock: concurrent tamper reports from two devices must serialize.
  await tx.$queryRaw`SELECT id FROM "TradeAccount" WHERE id = ${tradeAccountId}::uuid FOR UPDATE`;
  const account = await tx.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId } });
  const from = account.securityState as SecurityState;
  const { next, effects } = transition(from, event);

  await tx.tradeAccount.update({
    where: { id: tradeAccountId },
    data: { securityState: next as DbSecurityState, securityStateAt: new Date() },
  });

  const result: ApplyResult = { from, next, outbox: [] };
  if ("incidentId" in event) result.incidentId = event.incidentId;

  for (const effect of effects) {
    switch (effect.kind) {
      case "REVOKE_WEB_SESSIONS":
        await tx.webSession.updateMany({
          where: { revokedAt: null, user: { tradeAccountId } },
          data: { revokedAt: new Date() },
        });
        break;

      case "REVOKE_SYNC_TOKENS":
        // Sync tokens are short-lived and every sync call re-checks account state + device
        // certificate, so the state change committed above is what invalidates them.
        break;

      case "QUARANTINE_DEVICE":
        await tx.device.update({ where: { id: effect.deviceId }, data: { status: "QUARANTINED" } });
        break;

      case "OPEN_INCIDENT": {
        const incident = await tx.securityIncident.create({
          data: {
            tradeAccountId,
            deviceId: effect.deviceId,
            attestationId: effect.attestationId,
            kind: "BINARY_TAMPER",
          },
        });
        result.incidentId = incident.id;
        break;
      }

      case "SEND_TAMPER_ALERT_WITH_RECOVERY_TOKEN":
        result.outbox.push(...(await issueRecoveryEmails(tx, tradeAccountId, result.incidentId!)));
        break;

      case "REVOKE_DEVICE_CERTIFICATES":
        await tx.deviceCertificate.updateMany({
          where: { revokedAt: null, device: { status: "QUARANTINED", user: { tradeAccountId } } },
          data: { revokedAt: new Date(), revokeReason: "TAMPER_RECOVERY" },
        });
        break;

      case "ISSUE_RECOVERY_DOWNLOAD_GRANT": {
        const release = await tx.desktopRelease.findFirstOrThrow({
          where: { revokedAt: null, platform: ctx.platform ?? "win-x64" },
          orderBy: { publishedAt: "desc" },
        });
        const grant = await tx.downloadGrant.create({
          data: {
            userId: ctx.actorId!,
            releaseId: release.id,
            reason: "RECOVERY",
            incidentId: result.incidentId ?? null,
            expiresAt: new Date(Date.now() + config.downloadGrantTtlSec * 1000),
          },
        });
        result.downloadGrantId = grant.id;
        break;
      }

      case "RESOLVE_INCIDENT":
        await tx.securityIncident.update({ where: { id: effect.incidentId }, data: { resolvedAt: new Date() } });
        break;

      case "AUDIT":
        await tx.auditLog.create({
          data: {
            actorId: ctx.actorId ?? null,
            accountId: tradeAccountId,
            action: effect.action,
            meta: { ...effect.meta, from, next },
            ip: ctx.ip ?? null,
          },
        });
        break;
    }
  }
  return result;
}

/** One single-use token per account owner; only its hash is persisted. */
export async function issueRecoveryEmails(tx: Tx, tradeAccountId: string, incidentId: string): Promise<OutboundEmail[]> {
  const incident = await tx.securityIncident.findUniqueOrThrow({ where: { id: incidentId } });
  const [account, device, attestation, owners] = await Promise.all([
    tx.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId } }),
    tx.device.findUniqueOrThrow({ where: { id: incident.deviceId } }),
    tx.attestation.findUniqueOrThrow({ where: { id: incident.attestationId } }),
    tx.user.findMany({ where: { tradeAccountId, isAccountOwner: true } }),
  ]);
  const expiresAt = new Date(Date.now() + config.recoveryTokenTtlSec * 1000);
  const mismatchCount = Array.isArray(attestation.mismatches) ? attestation.mismatches.length : 0;

  const out: OutboundEmail[] = [];
  for (const owner of owners) {
    const raw = randomToken(32);
    await tx.recoveryToken.create({ data: { incidentId, userId: owner.id, tokenHash: sha256Hex(raw), expiresAt } });
    out.push(
      tamperAlertEmail({
        to: owner.email,
        fullName: owner.fullName,
        accountCode: account.code,
        deviceLabel: device.label,
        detectedAt: attestation.createdAt,
        mismatchCount,
        recoveryToken: raw,
        expiresAt,
      }),
    );
  }
  return out;
}

/**
 * Sends queued security mail after the lock has committed, then advances
 * LOCKED_TAMPER → RECOVERY_PENDING. If delivery fails the account simply stays locked
 * (fail-safe) and the owner can request a resend from the portal's lock screen.
 */
export async function flushSecurityOutbox(tradeAccountId: string, r: ApplyResult): Promise<void> {
  if (r.outbox.length === 0 || !r.incidentId) return;
  try {
    await Promise.all(r.outbox.map(sendMail));
  } catch (err) {
    console.error(`[security] recovery email delivery failed for ${tradeAccountId}`, err);
    return;
  }
  await prisma.$transaction((tx) =>
    applySecurityEvent(tx, tradeAccountId, { type: "RECOVERY_EMAIL_SENT", incidentId: r.incidentId! }),
  );
}
