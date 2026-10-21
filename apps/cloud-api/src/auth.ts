import type { FastifyReply, FastifyRequest } from "fastify";
import type { TradeAccount, User } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { sha256Hex } from "./lib/crypto.js";
import { isLocked, type SecurityState } from "./security/stateMachine.js";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = code) {
    super(message);
  }
}

export const SESSION_COOKIE = "dl_session";
export const SESSION_TTL_SEC = 12 * 3600;

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function setSessionCookie(reply: FastifyReply, token: string | null): void {
  const secure = config.portalOrigin.startsWith("https://") ? "; Secure" : "";
  const value = token
    ? `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure}`
    : `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  void reply.header("set-cookie", value);
}

/**
 * CSRF: the session cookie is SameSite=Lax, and every state-changing request must carry an
 * Origin (or Referer) from the portal itself. JSON bodies also force a CORS preflight.
 */
export function assertSameOrigin(req: FastifyRequest): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
  if (origin && origin !== config.portalOrigin && origin !== config.publicBaseUrl) {
    throw new HttpError(403, "BAD_ORIGIN");
  }
}

export interface SessionContext {
  user: User;
  account: TradeAccount | null;
  sessionId: string;
}

/** Resolves the web session without applying the account lock (used by /me and logout). */
export async function resolveSession(req: FastifyRequest): Promise<SessionContext> {
  assertSameOrigin(req);
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "UNAUTHENTICATED");
  const session = await prisma.webSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { include: { tradeAccount: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw new HttpError(401, "SESSION_INVALID");
  if (!session.user.active) throw new HttpError(401, "USER_DEACTIVATED");
  const { tradeAccount, ...user } = session.user;
  return { user, account: tradeAccount, sessionId: session.id };
}

/**
 * Resolves the web session and enforces the account security lock.
 * A locked account gets 423 with its state so the portal can render the lock/recovery screen.
 */
export async function requireUser(req: FastifyRequest): Promise<User> {
  return (await requireTrade(req, { allowStaff: true })).user;
}

export async function requireTrade(req: FastifyRequest, opts: { allowStaff?: boolean } = {}): Promise<SessionContext> {
  const ctx = await resolveSession(req);
  if (ctx.account) {
    if (ctx.account.status !== "APPROVED") throw new HttpError(403, "ACCOUNT_NOT_APPROVED");
    if (isLocked(ctx.account.securityState as SecurityState)) {
      throw new HttpError(423, "ACCOUNT_SECURITY_LOCK", ctx.account.securityState);
    }
  } else if (!opts.allowStaff) {
    throw new HttpError(403, "TRADE_ACCOUNT_REQUIRED");
  }
  return ctx;
}

export const isStaff = (u: Pick<User, "role">): boolean => u.role === "ADMIN" || u.role === "SALES_REP";

/**
 * Staff (admin portal) guard. Staff must have a confirmed authenticator before any admin action;
 * until then only the MFA enrollment endpoints work and this returns 403 MFA_SETUP_REQUIRED.
 */
export async function requireStaff(req: FastifyRequest, opts: { admin?: boolean } = {}): Promise<SessionContext> {
  const ctx = await resolveSession(req);
  if (!isStaff(ctx.user)) throw new HttpError(403, "STAFF_ONLY");
  if (opts.admin && ctx.user.role !== "ADMIN") throw new HttpError(403, "ADMIN_ONLY");
  const mfa = await prisma.mfaFactor.count({ where: { userId: ctx.user.id, confirmedAt: { not: null } } });
  if (!mfa) throw new HttpError(403, "MFA_SETUP_REQUIRED");
  return ctx;
}

export function errorHandler(err: Error & { statusCode?: number }, _req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    void reply.status(err.status).send({ error: err.code, detail: err.message });
    return;
  }
  if (err.name === "ZodError") {
    void reply.status(400).send({ error: "BAD_REQUEST", detail: err.message });
    return;
  }
  if (err.statusCode && err.statusCode < 500) {
    void reply.status(err.statusCode).send({ error: "BAD_REQUEST", detail: err.message });
    return;
  }
  console.error(err);
  void reply.status(500).send({ error: "INTERNAL" });
}
