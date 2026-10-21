import type { Role } from "@prisma/client";
import { config } from "./config.js";
import { prisma, type Tx } from "./db.js";
import { randomToken, sha256Hex } from "./lib/crypto.js";
import { sendMail } from "./mail.js";

/**
 * Onboarding primitives shared by the setup flow, the admin portal and the CLI.
 *
 * Each business that buys DROPLET gets its own install. A fresh install has no administrator;
 * the operator generates a one-time setup link (printed at first boot, or `npm run setup-link`)
 * and sends it to the business. Opening it creates the first ADMIN, who then invites staff and
 * approves trade customers from the admin portal.
 */

export const SETUP_LINK_TTL_HOURS = 72;
export const INVITE_TTL_DAYS = 7;

export async function businessProfile(db: Tx | typeof prisma = prisma) {
  return db.businessProfile.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export async function adminExists(db: Tx | typeof prisma = prisma): Promise<boolean> {
  return (await db.user.count({ where: { role: "ADMIN", active: true } })) > 0;
}

/** Issues a new one-time setup link (replacing any earlier one). Only valid while no admin exists. */
export async function createSetupLink(): Promise<{ url: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_HOURS * 3_600_000);
  await businessProfile();
  await prisma.businessProfile.update({
    where: { id: 1 },
    data: { setupTokenHash: sha256Hex(token), setupTokenExpiresAt: expiresAt },
  });
  return { url: `${config.portalOrigin}/setup?token=${encodeURIComponent(token)}`, expiresAt };
}

/** At boot: if the install has no administrator yet, print a setup link for the operator. */
export async function announceSetupIfNeeded(log: (msg: string) => void): Promise<void> {
  if (await adminExists()) return;
  const { url, expiresAt } = await createSetupLink();
  log(
    [
      "",
      "────────────────────────────────────────────────────────────────",
      " DROPLET has no administrator yet. Send this one-time link to the",
      " business owner to create the first admin account:",
      `   ${url}`,
      ` Expires ${expiresAt.toISOString()}. New link: npm run setup-link`,
      " (Docker/Coolify: node dist/scripts/setup-link.js in the container terminal)",
      "────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

export async function createInvite(
  db: Tx,
  args: { email: string; role: Role; fullName?: string | null; tradeAccountId?: string | null; invitedById: string },
): Promise<{ url: string; expiresAt: Date }> {
  const email = args.email.toLowerCase();
  // One live invite per email + scope.
  await db.invite.updateMany({
    where: { email, acceptedAt: null, revokedAt: null, tradeAccountId: args.tradeAccountId ?? null },
    data: { revokedAt: new Date() },
  });
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
  await db.invite.create({
    data: {
      tokenHash: sha256Hex(token),
      email,
      fullName: args.fullName ?? null,
      role: args.role,
      tradeAccountId: args.tradeAccountId ?? null,
      invitedById: args.invitedById,
      expiresAt,
    },
  });
  return { url: `${config.portalOrigin}/invite?token=${encodeURIComponent(token)}`, expiresAt };
}

/** Best-effort notification; email failure never blocks the admin action. */
export async function notify(to: string, subject: string, lines: string[]): Promise<void> {
  const profile = await businessProfile();
  try {
    await sendMail({ to, subject: `[${profile.name}] ${subject}`, text: lines.join("\n") });
  } catch (e) {
    console.error("[mail] delivery failed", e);
  }
}
