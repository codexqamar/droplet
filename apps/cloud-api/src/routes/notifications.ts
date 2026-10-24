import type { FastifyInstance } from "fastify";
import type { AuditLog, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireStaff, type SessionContext } from "../auth.js";

/**
 * Admin portal notifications, derived from the audit log (single source of truth, nothing to
 * keep in sync). Live delivery is Server-Sent Events polling the DB every few seconds, so it
 * works across several API instances without a message bus. Desktop staff, whose cloud proxy
 * cannot hold a stream open, poll the list endpoint instead.
 */

type Kind = "application" | "order" | "approval" | "quote" | "security" | "people" | "device";
interface Notice {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  link: string;
  at: string;
}

const NOTIFY_ACTIONS = [
  "account.apply",
  "order.web",
  "order.desktop",
  "order.rep",
  "quote.request",
  "quote.accept",
  "security.lock",
  "invite.accept",
  "device.enroll",
  "order.buyer_approve",
  "payment.succeeded",
] as const;

/** Which events a staff member sees: admins everything; account managers their accounts only. */
async function scope(ctx: SessionContext): Promise<Prisma.AuditLogWhereInput> {
  // Leave out the viewer's own actions. Written as an OR so anonymous events (actorId NULL,
  // e.g. applications) are kept: in SQL, NOT (actorId = me) is never true for NULL.
  const base: Prisma.AuditLogWhereInput = { action: { in: [...NOTIFY_ACTIONS] }, OR: [{ actorId: null }, { actorId: { not: ctx.user.id } }] };
  if (ctx.user.role === "ADMIN") return base;
  const ids = (await prisma.repAssignment.findMany({ where: { repId: ctx.user.id }, select: { tradeAccountId: true } })).map((r) => r.tradeAccountId);
  return { ...base, accountId: { in: ids }, action: { in: NOTIFY_ACTIONS.filter((a) => a !== "account.apply" && a !== "security.lock") } };
}

async function describe(rows: AuditLog[]): Promise<Notice[]> {
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const [accounts, actors] = await Promise.all([
    prisma.tradeAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, legalName: true } }),
    prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } }),
  ]);
  const acct = new Map(accounts.map((a) => [a.id, a.legalName]));
  const who = new Map(actors.map((u) => [u.id, u.fullName]));
  return rows.map((r) => {
    const account = (r.accountId && acct.get(r.accountId)) || "A trade account";
    const actor = (r.actorId && who.get(r.actorId)) || "Someone";
    const meta = (r.meta ?? {}) as { status?: string; email?: string };
    const base = { id: String(r.id), at: r.createdAt.toISOString() };
    switch (r.action) {
      case "account.apply":
        return { ...base, kind: "application", title: "New account application", body: `${(meta as { company?: string }).company ?? meta.email ?? "A business"} applied (${r.target ?? ""}).`, link: "/admin/accounts" };
      case "order.web":
      case "order.desktop":
      case "order.rep":
        return meta.status === "PENDING_APPROVAL"
          ? { ...base, kind: "approval", title: "Order needs approval", body: `${account}: over the credit limit.`, link: "/admin/orders" }
          : meta.status === "AWAITING_BUYER_APPROVAL"
            ? { ...base, kind: "order", title: "Order waiting on customer sign-off", body: `${account} · ${actor} is over their spending limit; their approver has been asked.`, link: "/admin/orders" }
            : { ...base, kind: "order", title: meta.status === "DRAFT" ? "Draft order saved" : "New order", body: `${account} · ${actor}${r.action === "order.desktop" ? " (desktop)" : ""}.`, link: "/admin/orders" };
      case "order.buyer_approve":
        return { ...base, kind: "order", title: "Order approved by customer", body: `${account} · ${actor} approved ${r.target ?? "an order"}.`, link: "/admin/orders" };
      case "payment.succeeded":
        return { ...base, kind: "order", title: "Payment received", body: `${account} paid ${(((meta as { amountMinor?: number }).amountMinor ?? 0) / 100).toFixed(2)} online.`, link: "/admin/accounts" };
      case "quote.request":
        return { ...base, kind: "quote", title: "New quote request", body: `${account} · ${actor}.`, link: "/admin/quotes" };
      case "quote.accept":
        return { ...base, kind: "quote", title: "Quote accepted", body: `${account} accepted ${r.target ?? "a quote"}.`, link: "/admin/orders" };
      case "security.lock":
        return { ...base, kind: "security", title: "Security lock", body: `${account} was locked: desktop files modified.`, link: "/admin/security" };
      case "invite.accept":
        return { ...base, kind: "people", title: "Invitation accepted", body: `${actor} joined${r.accountId ? ` ${account}` : " the team"}.`, link: r.accountId ? "/admin/accounts" : "/admin/team" };
      default:
        return { ...base, kind: "device", title: "Desktop app connected", body: `${actor} connected a computer.`, link: "/admin/security" };
    }
  });
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { after?: string } }>("/v1/admin/notifications", async (req) => {
    const ctx = await requireStaff(req);
    const where = await scope(ctx);
    const after = req.query.after && /^\d+$/.test(req.query.after) ? BigInt(req.query.after) : null;
    const rows = await prisma.auditLog.findMany({ where: after ? { ...where, id: { gt: after } } : where, orderBy: { id: "desc" }, take: 30 });
    const seen = ctx.user.notificationsSeenAt ?? new Date(0);
    const unread = await prisma.auditLog.count({ where: { ...where, createdAt: { gt: seen } } });
    return { items: await describe(rows), unread, latestId: rows[0] ? String(rows[0].id) : req.query.after ?? null };
  });

  app.post("/v1/admin/notifications/seen", async (req) => {
    const ctx = await requireStaff(req);
    await prisma.user.update({ where: { id: ctx.user.id }, data: { notificationsSeenAt: new Date() } });
    return { ok: true };
  });

  /** Live stream: one `notice` event per new item, plus a heartbeat so proxies keep it open. */
  app.get("/v1/admin/notifications/stream", async (req, reply) => {
    const ctx = await requireStaff(req);
    const where = await scope(ctx);
    let lastId = (await prisma.auditLog.findFirst({ where, orderBy: { id: "desc" }, select: { id: true } }))?.id ?? 0n;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 5000\n\n");

    let closed = false;
    let ticks = 0;
    const tick = async () => {
      if (closed) return;
      try {
        // Re-check the session so a sign-out or deactivation ends the stream.
        const session = await prisma.webSession.findUnique({ where: { id: ctx.sessionId }, include: { user: true } });
        if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.active) {
          res.write("event: signed-out\ndata: {}\n\n");
          return res.end();
        }
        const rows = await prisma.auditLog.findMany({ where: { ...where, id: { gt: lastId } }, orderBy: { id: "asc" }, take: 20 });
        if (rows.length) {
          lastId = rows[rows.length - 1]!.id;
          for (const n of await describe(rows)) res.write(`event: notice\ndata: ${JSON.stringify(n)}\n\n`);
        } else if (++ticks % 5 === 0) {
          res.write(": ping\n\n");
        }
      } catch (e) {
        req.log.warn(e);
      }
      if (!closed) setTimeout(() => void tick(), 3000);
    };
    req.raw.on("close", () => {
      closed = true;
    });
    void tick();
  });
}
