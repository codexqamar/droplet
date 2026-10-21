import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, assertSameOrigin } from "../auth.js";
import { sha256Hex } from "../lib/crypto.js";
import { hashPassword } from "../lib/mfa.js";
import { adminExists, businessProfile } from "../onboarding.js";

const Password = z.string().min(12, "Use at least 12 characters").max(512);

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  /** Public: business name for page titles, and whether first-run setup is still open. */
  app.get("/v1/public/profile", async () => {
    const p = await businessProfile();
    return { name: p.name, supportEmail: p.supportEmail, needsSetup: !(await adminExists()) };
  });

  /**
   * First-run setup: the one-time link creates the business profile and the first administrator.
   * Closed for good once an active admin exists.
   */
  app.post("/v1/setup", async (req, reply) => {
    assertSameOrigin(req);
    const body = z
      .object({
        token: z.string().min(20),
        businessName: z.string().trim().min(2).max(160),
        fullName: z.string().trim().min(2).max(120),
        email: z.string().email().max(254),
        password: Password,
      })
      .parse(req.body);

    await prisma.$transaction(
      async (tx) => {
        if (await adminExists(tx)) throw new HttpError(409, "SETUP_ALREADY_COMPLETE");
        const p = await businessProfile(tx);
        if (!p.setupTokenHash || p.setupTokenHash !== sha256Hex(body.token) || !p.setupTokenExpiresAt || p.setupTokenExpiresAt < new Date()) {
          throw new HttpError(401, "SETUP_LINK_INVALID");
        }
        const email = body.email.toLowerCase();
        if (await tx.user.findUnique({ where: { email } })) throw new HttpError(409, "EMAIL_IN_USE");
        const admin = await tx.user.create({
          data: { email, fullName: body.fullName, role: "ADMIN", passwordHash: await hashPassword(body.password) },
        });
        await tx.businessProfile.update({
          where: { id: 1 },
          data: { name: body.businessName, supportEmail: email, setupTokenHash: null, setupTokenExpiresAt: null, setupCompletedAt: new Date() },
        });
        await tx.auditLog.create({ data: { actorId: admin.id, actorRole: "ADMIN", action: "setup.complete", meta: { businessName: body.businessName }, ip: req.ip } });
      },
      { isolationLevel: "Serializable" },
    );
    return reply.status(201).send({ ok: true });
  });

  /** Invitation preview (who invited, which account) before the person sets a password. */
  app.get<{ Params: { token: string } }>("/v1/invites/:token", async (req) => {
    const invite = await prisma.invite.findUnique({ where: { tokenHash: sha256Hex(req.params.token) } });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) throw new HttpError(410, "INVITE_INVALID");
    const account = invite.tradeAccountId ? await prisma.tradeAccount.findUnique({ where: { id: invite.tradeAccountId } }) : null;
    return { email: invite.email, fullName: invite.fullName, role: invite.role, accountName: account?.legalName ?? null, business: (await businessProfile()).name };
  });

  app.post("/v1/invites/accept", async (req, reply) => {
    assertSameOrigin(req);
    const body = z.object({ token: z.string().min(20), fullName: z.string().trim().min(2).max(120), password: Password }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { tokenHash: sha256Hex(body.token) } });
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) throw new HttpError(410, "INVITE_INVALID");
      if (await tx.user.findUnique({ where: { email: invite.email } })) throw new HttpError(409, "EMAIL_IN_USE");
      const owners = invite.tradeAccountId ? await tx.user.count({ where: { tradeAccountId: invite.tradeAccountId, isAccountOwner: true } }) : 1;
      const user = await tx.user.create({
        data: {
          email: invite.email,
          fullName: body.fullName,
          role: invite.role,
          tradeAccountId: invite.tradeAccountId,
          // The first person on an admin-created account owns it (receives security alerts).
          isAccountOwner: invite.tradeAccountId ? owners === 0 : false,
          passwordHash: await hashPassword(body.password),
        },
      });
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: user.id, actorRole: user.role, accountId: invite.tradeAccountId, action: "invite.accept", ip: req.ip } });
    });
    return reply.status(201).send({ ok: true });
  });
}
