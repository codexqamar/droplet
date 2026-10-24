import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireTrade, HttpError, type SessionContext } from "../auth.js";
import { catalogueFor, buildDashboard, stockByBranch } from "../portalData.js";
import { createOrder, createQuote, creditStatus, emitOrder, isOrderApprover } from "../orders.js";
import { createInvite, notify } from "../onboarding.js";
import { completePayment, paymentsConfig, refreshPayment, startPayment } from "../payments.js";
import { randomBytes } from "node:crypto";

const Lines = z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(1_000_000) })).min(1).max(500);
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

async function requireApprover(ctx: SessionContext) {
  const me = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
  if (!isOrderApprover(me)) throw new HttpError(403, "APPROVER_ONLY");
  return me;
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/portal/dashboard", async (req) => {
    const ctx = await requireTrade(req);
    const [dashboard, catalogue] = await Promise.all([
      buildDashboard(ctx.account!.id, ctx.user.id),
      catalogueFor(prisma, ctx.account!.id, { active: true }),
    ]);
    return { ...dashboard, catalogue: catalogue.map(({ syncVersion: _v, id: _id, active: _a, ...c }) => c) };
  });

  /** Live availability, polled by the catalogue and quick-order screens. */
  app.get("/v1/portal/stock", async (req) => {
    const ctx = await requireTrade(req);
    const account = ctx.account!;
    const products = await prisma.product.findMany({
      where: { active: true, ...(account.catalogueId ? { catalogues: { some: { catalogueId: account.catalogueId } } } : {}) },
      select: { id: true, sku: true, stockQty: true, leadTimeDays: true },
    });
    const branches = await stockByBranch(prisma, products.map((p) => p.id));
    return { at: new Date().toISOString(), items: products.map((p) => ({ sku: p.sku, stock: p.stockQty, leadTimeDays: p.leadTimeDays, branches: branches.get(p.id) ?? [] })) };
  });

  app.post("/v1/orders", async (req) => {
    const ctx = await requireTrade(req);
    const body = z
      .object({ lines: Lines, poNumber: z.string().trim().max(64).optional(), mode: z.enum(["submit", "draft"]).default("submit") })
      .parse(req.body);
    const { order, status } = await prisma.$transaction((tx) =>
      createOrder(tx, {
        tradeAccountId: ctx.account!.id,
        userId: ctx.user.id,
        channel: "WEB",
        lines: body.lines,
        submit: body.mode === "submit",
        poNumber: body.poNumber,
      }),
    );
    emitOrder(order);
    if (status === "AWAITING_BUYER_APPROVAL") {
      const approvers = await prisma.user.findMany({ where: { tradeAccountId: ctx.account!.id, active: true, id: { not: ctx.user.id }, OR: [{ isAccountOwner: true }, { canApproveOrders: true }] } });
      for (const a of approvers) {
        await notify(a.email, `Order ${order.number} needs your approval`, [`Hello ${a.fullName},`, "", `${ctx.user.fullName} placed order ${order.number}, which is above their spending limit. Approve or reject it in the trade portal under Orders.`]);
      }
    }
    return { number: order.number, status, totalMinor: Number(order.totalMinor) };
  });

  /** Buyer-side approval of a colleague's order (owner or nominated approver on the same account). */
  for (const action of ["approve", "reject"] as const) {
    app.post<{ Params: { number: string } }>(`/v1/portal/orders/:number/${action}`, async (req) => {
      const ctx = await requireTrade(req);
      await requireApprover(ctx);
      const { order, placedBy } = await prisma.$transaction(async (tx) => {
        const o = await tx.order.findFirst({ where: { number: req.params.number, tradeAccountId: ctx.account!.id }, include: { placedBy: true } });
        if (!o) throw new HttpError(404, "ORDER_NOT_FOUND");
        if (o.status !== "AWAITING_BUYER_APPROVAL") throw new HttpError(409, "NOT_AWAITING_APPROVAL");
        const status = action === "approve" ? await creditStatus(tx, o.tradeAccountId, o.totalMinor) : "CANCELLED";
        const updated = await tx.order.update({ where: { id: o.id }, data: { status, buyerApprovedById: ctx.user.id, version: { increment: 1 }, submittedAt: new Date() } });
        await tx.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: o.tradeAccountId, action: `order.buyer_${action}`, target: o.number, ip: req.ip } });
        return { order: updated, placedBy: o.placedBy };
      });
      if (action === "approve") emitOrder(order);
      await notify(placedBy.email, `Order ${order.number} ${action === "approve" ? "approved" : "rejected"}`, [
        `Hello ${placedBy.fullName},`,
        "",
        action === "approve" ? `${ctx.user.fullName} approved order ${order.number}. It has been sent to your supplier.` : `${ctx.user.fullName} rejected order ${order.number}.`,
      ]);
      return { number: order.number, status: order.status };
    });
  }

  app.post("/v1/quotes", async (req) => {
    const ctx = await requireTrade(req);
    const body = z.object({ lines: Lines, notes: z.string().max(2000).optional() }).parse(req.body);
    const quote = await prisma.$transaction((tx) =>
      createQuote(tx, { tradeAccountId: ctx.account!.id, userId: ctx.user.id, lines: body.lines, notes: body.notes }),
    );
    return { number: quote.number, status: quote.status };
  });

  /** Accept an offered quote: becomes an order at the offered prices (subject to the credit check). */
  app.post<{ Params: { number: string } }>("/v1/quotes/:number/accept", async (req) => {
    const ctx = await requireTrade(req);
    const { poNumber } = z.object({ poNumber: z.string().trim().max(64).optional() }).parse(req.body ?? {});
    const order = await prisma.$transaction(async (tx) => {
      const q = await tx.quote.findFirst({ where: { number: req.params.number, tradeAccountId: ctx.account!.id }, include: { lines: true } });
      if (!q) throw new HttpError(404, "QUOTE_NOT_FOUND");
      if (q.status !== "OFFERED") throw new HttpError(409, "QUOTE_NOT_OFFERED");
      if (q.validUntil && q.validUntil < new Date()) {
        await tx.quote.update({ where: { id: q.id }, data: { status: "EXPIRED" } });
        throw new HttpError(409, "QUOTE_EXPIRED");
      }
      const lines = q.lines.map((l) => {
        const unit = l.offeredMinor ?? 0n;
        return { productId: l.productId, qty: l.qty, unitMinor: unit, lineMinor: unit * BigInt(l.qty), priceSource: "QUOTE" };
      });
      const total = lines.reduce((s, l) => s + l.lineMinor, 0n);
      const acct = await tx.tradeAccount.findUniqueOrThrow({ where: { id: ctx.account!.id } });
      const status = await creditStatus(tx, acct.id, total);
      const o = await tx.order.create({
        data: {
          number: `DL-${new Date().getFullYear()}-${randomBytes(4).toString("hex").toUpperCase()}`,
          tradeAccountId: acct.id,
          status,
          channel: "WEB",
          poNumber: poNumber || null,
          placedById: ctx.user.id,
          quoteId: q.id,
          subtotalMinor: total,
          totalMinor: total,
          submittedAt: new Date(),
          lines: { create: lines },
        },
      });
      await tx.quote.update({ where: { id: q.id }, data: { status: "ACCEPTED" } });
      await tx.auditLog.create({ data: { actorId: ctx.user.id, accountId: acct.id, action: "quote.accept", target: q.number } });
      return o;
    });
    emitOrder(order);
    return { number: order.number, status: order.status, totalMinor: Number(order.totalMinor) };
  });

  // ───────────── saved order lists (per job, site or location) ─────────────
  const ListBody = z.object({ name: z.string().trim().min(1).max(80), note: z.string().trim().max(500).nullable().optional(), lines: Lines.max(300) });

  async function writeListItems(listId: string, lines: Array<{ sku: string; qty: number }>) {
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.sku.toUpperCase(), (merged.get(l.sku.toUpperCase()) ?? 0) + l.qty);
    const products = await prisma.product.findMany({ where: { sku: { in: [...merged.keys()] } } });
    const unknown = [...merged.keys()].filter((s) => !products.some((p) => p.sku === s));
    if (unknown.length) throw new HttpError(422, "UNKNOWN_SKU", unknown.join(", "));
    await prisma.$transaction([
      prisma.orderListItem.deleteMany({ where: { listId } }),
      prisma.orderListItem.createMany({ data: [...merged].map(([sku, qty], i) => ({ listId, productId: products.find((p) => p.sku === sku)!.id, qty, sortOrder: i })) }),
    ]);
  }

  app.get("/v1/portal/lists", async (req) => {
    const ctx = await requireTrade(req);
    const lists = await prisma.orderList.findMany({
      where: { tradeAccountId: ctx.account!.id },
      include: { items: { include: { product: { select: { sku: true, name: true } } }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    });
    const authors = new Map((await prisma.user.findMany({ where: { id: { in: lists.map((l) => l.createdById) } } })).map((u) => [u.id, u.fullName]));
    return {
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        note: l.note,
        createdBy: authors.get(l.createdById) ?? "A colleague",
        updatedAt: l.updatedAt.toISOString(),
        lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
        items: l.items.map((i) => ({ sku: i.product.sku, name: i.product.name, qty: i.qty })),
      })),
    };
  });

  app.post("/v1/portal/lists", async (req) => {
    const ctx = await requireTrade(req);
    const b = ListBody.parse(req.body);
    const list = await prisma.orderList.create({ data: { tradeAccountId: ctx.account!.id, name: b.name, note: b.note ?? null, createdById: ctx.user.id } });
    try {
      await writeListItems(list.id, b.lines);
    } catch (e) {
      await prisma.orderList.delete({ where: { id: list.id } });
      throw e;
    }
    await prisma.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: ctx.account!.id, action: "list.create", target: b.name } });
    return { id: list.id };
  });

  app.put<{ Params: { id: string } }>("/v1/portal/lists/:id", async (req) => {
    const ctx = await requireTrade(req);
    const b = ListBody.parse(req.body);
    const list = await prisma.orderList.findFirst({ where: { id: req.params.id, tradeAccountId: ctx.account!.id } });
    if (!list) throw new HttpError(404, "LIST_NOT_FOUND");
    await writeListItems(list.id, b.lines);
    await prisma.orderList.update({ where: { id: list.id }, data: { name: b.name, note: b.note ?? null } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/portal/lists/:id/used", async (req) => {
    const ctx = await requireTrade(req);
    await prisma.orderList.updateMany({ where: { id: req.params.id, tradeAccountId: ctx.account!.id }, data: { lastUsedAt: new Date() } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/v1/portal/lists/:id", async (req) => {
    const ctx = await requireTrade(req);
    const r = await prisma.orderList.deleteMany({ where: { id: req.params.id, tradeAccountId: ctx.account!.id } });
    if (!r.count) throw new HttpError(404, "LIST_NOT_FOUND");
    return { ok: true };
  });

  // ───────────── team (multi-user trade accounts) ─────────────
  app.get("/v1/portal/team", async (req) => {
    const ctx = await requireTrade(req);
    const [users, invites] = await Promise.all([
      prisma.user.findMany({ where: { tradeAccountId: ctx.account!.id }, orderBy: [{ isAccountOwner: "desc" }, { fullName: "asc" }] }),
      prisma.invite.findMany({ where: { tradeAccountId: ctx.account!.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return {
      users: users.map((u) => ({ id: u.id, name: u.fullName, email: u.email, owner: u.isAccountOwner, canApprove: isOrderApprover(u), spendLimitMinor: u.spendLimitMinor === null ? null : n(u.spendLimitMinor), active: u.active, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt.toISOString() })),
    };
  });

  app.post("/v1/portal/team/invites", async (req) => {
    const ctx = await requireTrade(req);
    const me = await requireApprover(ctx);
    if (!me.isAccountOwner) throw new HttpError(403, "OWNER_ONLY");
    const body = z.object({ email: z.string().email().max(254), fullName: z.string().trim().max(120).optional() }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })) throw new HttpError(409, "EMAIL_IN_USE");
    const invite = await prisma.$transaction(async (tx) => {
      const i = await createInvite(tx, { email: body.email, fullName: body.fullName, role: "TRADE_CUSTOMER", tradeAccountId: ctx.account!.id, invitedById: ctx.user.id });
      await tx.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: ctx.account!.id, action: "account.invite_user", target: body.email, ip: req.ip } });
      return i;
    });
    await notify(body.email, `Join ${ctx.account!.legalName} on the trade portal`, [`${ctx.user.fullName} invited you to order on ${ctx.account!.legalName}'s trade account. Set your password here:`, `  ${invite.url}`]);
    return { inviteUrl: invite.url };
  });

  app.patch<{ Params: { id: string } }>("/v1/portal/team/:id", async (req) => {
    const ctx = await requireTrade(req);
    const me = await requireApprover(ctx);
    if (!me.isAccountOwner) throw new HttpError(403, "OWNER_ONLY");
    const b = z.object({ canApprove: z.boolean().optional(), spendLimitMinor: z.number().int().min(0).max(1_000_000_000_00).nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const u = await prisma.user.findFirst({ where: { id: req.params.id, tradeAccountId: ctx.account!.id } });
    if (!u) throw new HttpError(404, "USER_NOT_FOUND");
    if (u.id === me.id && (b.active === false || b.canApprove === false)) throw new HttpError(409, "CANNOT_CHANGE_SELF");
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: u.id },
        data: {
          ...(b.canApprove !== undefined ? { canApproveOrders: b.canApprove } : {}),
          ...(b.spendLimitMinor !== undefined ? { spendLimitMinor: b.spendLimitMinor === null ? null : BigInt(b.spendLimitMinor) } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
        },
      });
      if (b.active === false) await tx.webSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: ctx.account!.id, action: "account.user_update", target: u.email, meta: b, ip: req.ip } });
    });
    return { ok: true };
  });

  // ───────────── online payments ─────────────
  app.post("/v1/portal/payments", async (req) => {
    const ctx = await requireTrade(req);
    const b = z.object({ amountMinor: z.number().int().min(100).max(1_000_000_000_00), reference: z.string().trim().min(1).max(80).default("Statement balance") }).parse(req.body);
    const balance = n((await prisma.ledgerEntry.aggregate({ where: { tradeAccountId: ctx.account!.id }, _sum: { amountMinor: true } }))._sum.amountMinor);
    if (b.amountMinor > balance) throw new HttpError(422, "AMOUNT_EXCEEDS_BALANCE", "You can pay up to your current statement balance.");
    const r = await startPayment({ tradeAccountId: ctx.account!.id, userId: ctx.user.id, email: ctx.user.email, amountMinor: BigInt(b.amountMinor), currency: ctx.account!.currency, reference: b.reference });
    await prisma.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: ctx.account!.id, action: "payment.start", target: r.id, meta: b, ip: req.ip } });
    return r;
  });

  app.get<{ Params: { id: string } }>("/v1/portal/payments/:id", async (req) => {
    const ctx = await requireTrade(req);
    const p = await prisma.payment.findFirst({ where: { id: req.params.id, tradeAccountId: ctx.account!.id } });
    if (!p) throw new HttpError(404, "PAYMENT_NOT_FOUND");
    const fresh = await refreshPayment(p);
    return { id: fresh.id, status: fresh.status, amountMinor: n(fresh.amountMinor), currency: fresh.currency, reference: fresh.reference, provider: fresh.provider, method: fresh.method };
  });

  /** Demo provider only: the simulated checkout page confirms here. */
  app.post<{ Params: { id: string } }>("/v1/portal/payments/:id/demo-complete", async (req) => {
    const ctx = await requireTrade(req);
    if (paymentsConfig().provider !== "demo") throw new HttpError(404, "NOT_FOUND");
    const { method, cancel } = z.object({ method: z.enum(["card", "bacs_debit"]).default("card"), cancel: z.boolean().optional() }).parse(req.body ?? {});
    const p = await prisma.payment.findFirst({ where: { id: req.params.id, tradeAccountId: ctx.account!.id, provider: "demo" } });
    if (!p) throw new HttpError(404, "PAYMENT_NOT_FOUND");
    if (cancel) {
      await prisma.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      return { status: "CANCELLED" };
    }
    const done = await completePayment(p.id, method);
    return { status: done.status };
  });
}
