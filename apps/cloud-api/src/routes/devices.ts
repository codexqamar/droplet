import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError } from "../auth.js";
import { canonicalJson, randomToken, sha256Hex, verifyEd25519 } from "../lib/crypto.js";
import { mintToken, readToken } from "../lib/signedToken.js";
import { applySecurityEvent, flushSecurityOutbox, type ApplyResult } from "../security/tripwire.js";
import { assertNotLimited, clearFailures, recordFailure } from "../lib/limiter.js";
import { verifyPassword, verifyTotp } from "../lib/mfa.js";

const Mismatch = z.object({ path: z.string().max(512), expected: z.string(), actual: z.string() });

const AttestPayload = z.object({
  v: z.literal(1),
  kind: z.literal("attest"),
  deviceId: z.string().uuid(),
  nonce: z.string().min(16),
  buildId: z.string().max(128),
  manifestRoot: z.string().regex(/^[0-9a-f]{64}$/),
  machineHash: z.string().regex(/^[0-9a-f]{64}$/),
  reporter: z.enum(["shell", "daemon"]),
  mismatches: z.array(Mismatch).max(10_000),
  ts: z.number().int(),
});

const EnrollPayload = z.object({
  v: z.literal(1),
  kind: z.literal("enroll"),
  enrollmentCode: z.string(),
  publicKey: z.string(),
  machineHash: z.string().regex(/^[0-9a-f]{64}$/),
  buildId: z.string().max(128),
  manifestRoot: z.string().regex(/^[0-9a-f]{64}$/),
  label: z.string().min(1).max(120),
  ts: z.number().int(),
});

const Signed = <T extends z.ZodTypeAny>(payload: T) => z.object({ payload, signature: z.string() });

export interface SyncClaims {
  deviceId: string;
  userId: string;
  tradeAccountId: string;
  certSerial: string;
}

function assertFresh(ts: number): void {
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > config.attestationClockSkewSec) {
    throw new HttpError(401, "STALE_TIMESTAMP");
  }
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Profile check for the desktop account switcher: is this install still a live account on
   * the web portal? Signed by the device key (read-only, so no nonce). Unknown devices get
   * GONE without a signature check, which reveals nothing about other accounts.
   */
  app.post("/v1/devices/status", async (req) => {
    const body = Signed(z.object({ v: z.literal(1), kind: z.literal("status"), deviceId: z.string().uuid(), ts: z.number().int() })).parse(req.body);
    const p = body.payload;
    const device = await prisma.device.findUnique({
      where: { id: p.deviceId },
      include: { user: { include: { tradeAccount: true } }, certificates: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, take: 1 } },
    });
    if (!device) return { state: "GONE" };
    if (!verifyEd25519(device.publicKey, canonicalJson(p), body.signature)) throw new HttpError(401, "BAD_SIGNATURE");
    assertFresh(p.ts);
    const acct = device.user.tradeAccount;
    const gone = device.status === "RETIRED" || !device.certificates.length || !device.user.active || !acct || acct.status === "REJECTED";
    if (gone && device.status !== "QUARANTINED") return { state: "GONE" };
    return {
      state: device.status === "QUARANTINED" || acct?.securityState !== "ACTIVE" ? "LOCKED" : acct.status === "APPROVED" ? "ACTIVE" : "SUSPENDED",
      account: acct ? { code: acct.code, legalName: acct.legalName, status: acct.status } : null,
    };
  });

  /**
   * Step 1 of the handshake: server-chosen nonce, single use, 60s.
   * Prevents a captured PASS attestation from being replayed by a tampered binary later.
   */
  /**
   * Desktop app lock: unlocking needs the device owner's portal password, then their
   * authenticator code. Signed by the device key with a fresh nonce, so a captured request
   * cannot be replayed and only this install can ask. Rate-limited per device.
   * Responses: { mfaRequired } after a correct password, { ok } after a correct code,
   * 403 MFA_NOT_SET_UP when the user has no authenticator (they set one up on the web first).
   */
  app.post("/v1/devices/unlock", async (req) => {
    const body = Signed(
      z.object({
        v: z.literal(1),
        kind: z.literal("unlock"),
        deviceId: z.string().uuid(),
        nonce: z.string().min(16),
        ts: z.number().int(),
        password: z.string().min(1).max(512),
        totp: z.string().regex(/^\d{6}$/).optional(),
      }),
    ).parse(req.body);
    const p = body.payload;
    const key = `unlock|${p.deviceId}`;
    assertNotLimited(key);
    const device = await prisma.device.findUnique({ where: { id: p.deviceId }, include: { user: { include: { tradeAccount: true } } } });
    if (!device || device.status === "RETIRED") throw new HttpError(403, "DEVICE_REVOKED");
    if (!verifyEd25519(device.publicKey, canonicalJson(p), body.signature)) throw new HttpError(401, "BAD_SIGNATURE");
    assertFresh(p.ts);
    const consumed = await prisma.attestationNonce.updateMany({
      where: { nonce: p.nonce, deviceId: device.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new HttpError(401, "NONCE_INVALID");

    const user = device.user;
    if (!user.active) throw new HttpError(403, "DEVICE_REVOKED");
    if (!(await verifyPassword(user.passwordHash, p.password))) {
      recordFailure(key);
      throw new HttpError(401, "INVALID_CREDENTIALS");
    }
    const factors = await prisma.mfaFactor.count({ where: { userId: user.id, confirmedAt: { not: null } } });
    if (!factors) throw new HttpError(403, "MFA_NOT_SET_UP");
    if (!p.totp) return { mfaRequired: true, name: user.fullName };
    if (!(await verifyTotp(prisma, user.id, p.totp))) {
      recordFailure(key);
      throw new HttpError(401, "INVALID_MFA_CODE");
    }
    clearFailures(key);
    await prisma.auditLog.create({ data: { actorId: user.id, actorRole: user.role, accountId: user.tradeAccountId, action: "device.unlock", target: device.label, ip: req.ip } });
    return { ok: true, name: user.fullName };
  });

  app.post<{ Params: { id: string } }>("/v1/devices/:id/challenge", async (req) => {
    const device = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!device || device.status === "RETIRED") throw new HttpError(404, "UNKNOWN_DEVICE");
    const nonce = randomToken(24);
    await prisma.attestationNonce.create({
      data: { nonce, deviceId: device.id, expiresAt: new Date(Date.now() + config.nonceTtlSec * 1000) },
    });
    return { nonce, expiresInSec: config.nonceTtlSec };
  });

  /**
   * Step 2: signed integrity report. Verdicts:
   *  - bad signature / replay / stale     → 401, logged, never triggers a lock (anyone can send garbage)
   *  - revoked build                      → 426, client must update; no lock
   *  - unknown build or file mismatches   → TAMPER: account lock + alert email
   *  - pass                               → short-lived sync token bound to device + certificate
   */
  app.post("/v1/attest", async (req, reply) => {
    const body = Signed(AttestPayload).parse(req.body);
    const p = body.payload;

    const device = await prisma.device.findUnique({
      where: { id: p.deviceId },
      include: {
        user: true,
        certificates: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { issuedAt: "desc" }, take: 1 },
      },
    });
    if (!device) throw new HttpError(404, "UNKNOWN_DEVICE");
    const cert = device.certificates[0];
    if (!cert || device.status === "QUARANTINED" || device.status === "RETIRED") {
      throw new HttpError(403, "DEVICE_REVOKED");
    }

    const record = (verdict: "PASS" | "TAMPER" | "UNKNOWN_BUILD" | "REVOKED_BUILD" | "BAD_SIGNATURE" | "REPLAY") =>
      prisma.attestation.create({
        data: {
          deviceId: device.id,
          buildId: p.buildId,
          manifestRoot: p.manifestRoot,
          verdict,
          mismatches: p.mismatches,
          payload: body as object,
          ip: req.ip,
        },
      });

    if (!verifyEd25519(device.publicKey, canonicalJson(p), body.signature)) {
      await record("BAD_SIGNATURE");
      throw new HttpError(401, "BAD_SIGNATURE");
    }
    assertFresh(p.ts);
    const consumed = await prisma.attestationNonce.updateMany({
      where: { nonce: p.nonce, deviceId: device.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      await record("REPLAY");
      throw new HttpError(401, "NONCE_INVALID");
    }

    const release = await prisma.desktopRelease.findUnique({ where: { buildId: p.buildId } });
    if (release?.revokedAt) {
      await record("REVOKED_BUILD");
      return reply.status(426).send({ error: "BUILD_REVOKED", action: "UPDATE_REQUIRED" });
    }

    const tradeAccountId = device.user.tradeAccountId;
    const unknownBuild = !release || release.manifestRoot !== p.manifestRoot;
    if (unknownBuild || p.mismatches.length > 0) {
      const attestation = await record(unknownBuild ? "UNKNOWN_BUILD" : "TAMPER");
      if (!tradeAccountId) {
        // Staff devices: quarantine + audit; staff lockout is handled by the IdP, not the trade state machine.
        await prisma.device.update({ where: { id: device.id }, data: { status: "QUARANTINED" } });
        throw new HttpError(403, "TAMPER_DETECTED");
      }
      const result: ApplyResult = await prisma.$transaction((tx) =>
        applySecurityEvent(
          tx,
          tradeAccountId,
          { type: "TAMPER_CONFIRMED", deviceId: device.id, attestationId: attestation.id },
          { ip: req.ip },
        ),
      );
      await flushSecurityOutbox(tradeAccountId, result);
      return reply.status(423).send({ error: "TAMPER_DETECTED", action: "HALT" });
    }

    // Access follows the web portal: a deactivated user or a rejected/closed account loses the
    // desktop too; a suspended account keeps its install but cannot sync until reactivated.
    const owner = device.user.tradeAccountId ? await prisma.tradeAccount.findUnique({ where: { id: device.user.tradeAccountId } }) : null;
    if (!device.user.active || (owner && owner.status === "REJECTED")) throw new HttpError(403, "DEVICE_REVOKED");
    if (owner && owner.status !== "APPROVED") throw new HttpError(403, "ACCOUNT_SUSPENDED", owner.status);

    await record("PASS");
    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastAttestedAt: new Date(),
        status: device.status === "PENDING_ENROLLMENT" ? "TRUSTED" : device.status,
        releaseId: release.id,
      },
    });

    // A passing attestation from a freshly enrolled device closes an open recovery.
    if (tradeAccountId) {
      const account = await prisma.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId } });
      if (account.securityState === "AWAITING_CLEAN_INSTALL") {
        const incident = await prisma.securityIncident.findFirstOrThrow({
          where: { tradeAccountId, resolvedAt: null },
          orderBy: { openedAt: "desc" },
        });
        // Only an install enrolled after the incident proves a clean machine.
        if (device.createdAt < incident.openedAt) throw new HttpError(423, "ACCOUNT_SECURITY_LOCK", account.securityState);
        const quarantined = await prisma.device.findMany({
          where: { status: "QUARANTINED", user: { tradeAccountId } },
          select: { id: true },
        });
        await prisma.$transaction((tx) =>
          applySecurityEvent(tx, tradeAccountId, {
            type: "CLEAN_ATTESTATION_PASSED",
            incidentId: incident.id,
            deviceId: device.id,
            quarantinedDeviceIds: quarantined.map((d) => d.id),
          }),
        );
      } else if (account.securityState !== "ACTIVE") {
        throw new HttpError(423, "ACCOUNT_SECURITY_LOCK", account.securityState);
      }
    }

    const syncToken = mintToken<SyncClaims>(
      "sync",
      { deviceId: device.id, userId: device.userId, tradeAccountId: tradeAccountId ?? "", certSerial: cert.serial },
      config.syncTokenTtlSec,
    );
    return { verdict: "PASS", syncToken, expiresInSec: config.syncTokenTtlSec };
  });

  /**
   * Enrollment: the desktop proves possession of a fresh keypair and presents a portal-issued
   * enrollment code. A clean reinstall always produces a new keypair + machineHash, i.e. a new device.
   */
  app.post("/v1/devices/enroll", async (req) => {
    const body = Signed(EnrollPayload).parse(req.body);
    const p = body.payload;
    assertFresh(p.ts);
    if (!verifyEd25519(p.publicKey, canonicalJson(p), body.signature)) throw new HttpError(401, "BAD_SIGNATURE");

    const code = readToken<{ userId: string; grantId: string }>("enroll", p.enrollmentCode);
    if (!code) throw new HttpError(401, "ENROLLMENT_CODE_INVALID");

    const release = await prisma.desktopRelease.findUnique({ where: { buildId: p.buildId } });
    if (!release || release.revokedAt || release.manifestRoot !== p.manifestRoot) {
      throw new HttpError(403, "BUILD_NOT_TRUSTED");
    }
    const grant = await prisma.downloadGrant.findUnique({ where: { id: code.grantId } });
    if (!grant || grant.userId !== code.userId) throw new HttpError(401, "ENROLLMENT_CODE_INVALID");
    // During recovery only the build issued by the recovery grant may enroll.
    if (grant.reason === "RECOVERY" && grant.releaseId !== release.id) throw new HttpError(403, "BUILD_NOT_TRUSTED");

    const existing = await prisma.device.findUnique({
      where: { userId_machineHash: { userId: code.userId, machineHash: p.machineHash } },
    });
    if (existing) throw new HttpError(409, "MACHINE_ALREADY_ENROLLED");

    const device = await prisma.device.create({
      data: {
        userId: code.userId,
        label: p.label,
        publicKey: p.publicKey,
        machineHash: p.machineHash,
        releaseId: release.id,
        certificates: {
          create: {
            serial: sha256Hex(`${p.publicKey}:${Date.now()}:${randomToken(8)}`).slice(0, 32),
            expiresAt: new Date(Date.now() + config.certificateTtlDays * 86_400_000),
          },
        },
      },
      include: { certificates: true },
    });
    await prisma.auditLog.create({
      data: { actorId: code.userId, action: "device.enroll", target: device.id, meta: { buildId: p.buildId }, ip: req.ip },
    });
    return { deviceId: device.id, certificateSerial: device.certificates[0]!.serial };
  });
}
