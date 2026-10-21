import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, SESSION_TTL_SEC, assertSameOrigin, requireTrade, resolveSession, setSessionCookie } from "../auth.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { assertNotLimited, clearFailures, recordFailure } from "../lib/limiter.js";
import { businessProfile } from "../onboarding.js";
import { encryptSecret, hashPassword, otpauthUri, decryptSecret, totpMatches, verifyPassword, verifyTotp } from "../lib/mfa.js";

function limiterKey(req: FastifyRequest, email: string) {
  return `${req.ip}|${email.toLowerCase()}`;
}

// Used to keep login timing flat when the email does not exist.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const Login = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(512),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const Apply = z.object({
  companyName: z.string().trim().min(2).max(160),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  phone: z.string().trim().max(40).optional(),
  password: z.string().min(12, "Use at least 12 characters").max(512),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/login", async (req, reply) => {
    assertSameOrigin(req);
    const body = Login.parse(req.body);
    const email = body.email.toLowerCase();
    const key = limiterKey(req, email);
    assertNotLimited(key);

    const user = await prisma.user.findUnique({
      where: { email },
      include: { tradeAccount: true, mfaFactors: { where: { confirmedAt: { not: null } } } },
    });
    const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !passwordOk || !user.active) {
      recordFailure(key);
      throw new HttpError(401, "INVALID_CREDENTIALS");
    }
    if (user.mfaFactors.length > 0) {
      if (!body.totp) return { mfaRequired: true };
      if (!(await verifyTotp(prisma, user.id, body.totp))) {
        recordFailure(key);
        throw new HttpError(401, "INVALID_MFA_CODE");
      }
    }
    clearFailures(key);

    const acct = user.tradeAccount;
    if (acct && acct.status !== "APPROVED") {
      throw new HttpError(403, "ACCOUNT_NOT_APPROVED", acct.status === "REJECTED" || acct.status === "SUSPENDED" ? `${acct.status}:${acct.statusReason ?? ""}` : acct.status);
    }
    // A locked account never gets a session; the portal shows the lock screen instead.
    if (acct && acct.securityState !== "ACTIVE") throw new HttpError(423, "ACCOUNT_SECURITY_LOCK", acct.securityState);

    const token = randomToken(32);
    await prisma.webSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        mfaAt: user.mfaFactors.length ? new Date() : null,
        ip: req.ip,
        userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorId: user.id, actorRole: user.role, accountId: acct?.id ?? null, action: "auth.login", ip: req.ip },
    });
    setSessionCookie(reply, token);
    return { ok: true, role: user.role, mfaEnabled: user.mfaFactors.length > 0 };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    try {
      const ctx = await resolveSession(req);
      await prisma.webSession.update({ where: { id: ctx.sessionId }, data: { revokedAt: new Date() } });
    } catch {
      /* already signed out */
    }
    setSessionCookie(reply, null);
    return { ok: true };
  });

  /** Session probe the portal calls on load. 401 → landing, 423 → lock screen, 200 → dashboard. */
  app.get("/v1/auth/me", async (req) => {
    const ctx = await requireTrade(req, { allowStaff: true });
    const mfa = await prisma.mfaFactor.count({ where: { userId: ctx.user.id, confirmedAt: { not: null } } });
    return {
      user: { name: ctx.user.fullName, email: ctx.user.email, role: ctx.user.role },
      staff: ctx.user.role !== "TRADE_CUSTOMER",
      mfaEnabled: mfa > 0,
      accountCode: ctx.account?.code ?? null,
    };
  });

  /** Trade account application. Creates a PENDING_APPROVAL account; no session until approved. */
  app.post("/v1/auth/apply", async (req, reply) => {
    assertSameOrigin(req);
    const body = Apply.parse(req.body);
    const email = body.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) {
      // Same response as success: do not reveal which emails are registered.
      return reply.status(202).send({ ok: true });
    }
    const code = `ACC-${randomBytes(3).readUIntBE(0, 3) % 90000 + 10000}`;
    const created = await prisma.tradeAccount.create({
      data: {
        code,
        legalName: body.companyName,
        phone: body.phone ?? null,
        currency: (await businessProfile()).currency,
        status: "PENDING_APPROVAL",
        users: {
          create: {
            email,
            fullName: body.fullName,
            passwordHash: await hashPassword(body.password),
            role: "TRADE_CUSTOMER",
            isAccountOwner: true,
          },
        },
      },
    });
    await prisma.auditLog.create({ data: { action: "account.apply", accountId: created.id, target: code, meta: { email, company: body.companyName }, ip: req.ip } });
    return reply.status(202).send({ ok: true });
  });

  /** Authenticator enrollment: create a pending secret, then confirm with a first code. */
  app.post("/v1/auth/mfa/setup", async (req) => {
    const ctx = await requireTrade(req, { allowStaff: true });
    await prisma.mfaFactor.deleteMany({ where: { userId: ctx.user.id, confirmedAt: null } });
    const secret = randomBytes(20);
    await prisma.mfaFactor.create({
      data: { userId: ctx.user.id, kind: "TOTP", secretEnc: encryptSecret(secret), label: "Authenticator app" },
    });
    return { otpauthUri: otpauthUri(ctx.user.email, secret) };
  });

  app.post("/v1/auth/mfa/confirm", async (req) => {
    const ctx = await requireTrade(req, { allowStaff: true });
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const pending = await prisma.mfaFactor.findFirst({ where: { userId: ctx.user.id, confirmedAt: null }, orderBy: { createdAt: "desc" } });
    if (!pending || !totpMatches(decryptSecret(pending.secretEnc), code)) throw new HttpError(401, "INVALID_MFA_CODE");
    await prisma.mfaFactor.update({ where: { id: pending.id }, data: { confirmedAt: new Date(), lastUsedAt: new Date() } });
    await prisma.auditLog.create({ data: { actorId: ctx.user.id, accountId: ctx.account?.id ?? null, action: "auth.mfa_enrolled", ip: req.ip } });
    return { ok: true };
  });
}
