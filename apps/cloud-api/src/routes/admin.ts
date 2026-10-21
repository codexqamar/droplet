import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountStatus, OrderStatus, Prisma, QuoteStatus, Role } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma, type Tx } from "../db.js";
import { HttpError, requireStaff, type SessionContext } from "../auth.js";
import { businessProfile, createInvite, notify } from "../onboarding.js";
import { applySecurityEvent } from "../security/tripwire.js";
import { catalogueFor } from "../portalData.js";
import { createOrder } from "../orders.js";
import type { SecurityState } from "../security/stateMachine.js";

/**
 * Admin portal API. ADMIN sees and manages everything; SALES_REP sees only assigned trade
 * accounts and can work their orders and quotes, but cannot approve applications, change
 * pricing/catalogue, manage staff or touch security settings.
 */

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const Money = z.number().int().min(0).max(1_000_000_000_00);

/** Restricts queries to the trade accounts a staff member may see. */
function accountScope(ctx: SessionContext): Prisma.TradeAccountWhereInput {
  return ctx.user.role === "ADMIN" ? {} : { reps: { some: { repId: ctx.user.id } } };
}

async function assertAccountAccess(ctx: SessionContext, tradeAccountId: string) {
  const acct = await prisma.tradeAccount.findFirst({ where: { id: tradeAccountId, ...accountScope(ctx) } });
  if (!acct) throw new HttpError(404, "ACCOUNT_NOT_FOUND");
  return acct;
}

const audit = (tx: Tx | typeof prisma, ctx: SessionContext, req: FastifyRequest, action: string, target?: string, accountId?: string | null, meta?: object) =>
  tx.auditLog.create({ data: { actorId: ctx.user.id, actorRole: ctx.user.role, accountId: accountId ?? null, action, target: target ?? null, meta: meta ?? undefined, ip: req.ip } });

/** Global monotonic version used by desktop delta sync. */
async function nextSyncVersion(tx: Tx): Promise<bigint> {
  const row = await tx.syncSequence.upsert({ where: { id: 1 }, create: { id: 1, value: 1n }, update: { value: { increment: 1n } } });
  return row.value;
}
async function bumpProducts(tx: Tx, productIds: string[]) {
  for (const id of productIds) await tx.product.update({ where: { id }, data: { syncVersion: await nextSyncVersion(tx) } });
}

async function defaultCatalogue(tx: Tx) {
  return (await tx.catalogue.findFirst({ orderBy: { updatedAt: "asc" } })) ?? tx.catalogue.create({ data: { name: "Main catalogue" } });
}

const orderFlow: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PENDING_APPROVAL: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PART_SHIPPED", "SHIPPED", "CANCELLED"],
  PART_SHIPPED: ["SHIPPED"],
  SHIPPED: ["INVOICED"],
};

function accountRow(a: Prisma.TradeAccountGetPayload<{ include: { priceTier: true; reps: { include: { rep: true } }; users: true; _count: { select: { orders: true } } } }>, balance: number) {
  const owner = a.users.find((u) => u.isAccountOwner) ?? a.users[0];
  return {
    id: a.id,
    code: a.code,
    legalName: a.legalName,
    phone: a.phone,
    status: a.status,
    statusReason: a.statusReason,
    securityState: a.securityState,
    tier: a.priceTier?.name ?? null,
    priceTierId: a.priceTierId,
    creditLimitMinor: n(a.creditLimitMinor),
    paymentTermsDays: a.paymentTermsDays,
    currency: a.currency,
    balanceMinor: balance,
    rep: a.reps[0] ? { id: a.reps[0].rep.id, name: a.reps[0].rep.fullName } : null,
    owner: owner ? { name: owner.fullName, email: owner.email } : null,
    users: a.users.length,
    orders: a._count.orders,
    createdAt: a.createdAt.toISOString(),
    approvedAt: a.approvedAt?.toISOString() ?? null,
  };
}

const accountInclude = { priceTier: true, reps: { include: { rep: true } }, users: true, _count: { select: { orders: true } } } as const;

async function balances(ids: string[]) {
  const rows = await prisma.ledgerEntry.groupBy({ by: ["tradeAccountId"], where: { tradeAccountId: { in: ids } }, _sum: { amountMinor: true } });
  return new Map(rows.map((r) => [r.tradeAccountId, n(r._sum.amountMinor)]));
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ───────────── overview ─────────────
  app.get("/v1/admin/overview", async (req) => {
    const ctx = await requireStaff(req);
    const scope = accountScope(ctx);
    const [profile, pending, approved, ordersAwaiting, openOrders, openQuotes, incidents, recent] = await Promise.all([
      businessProfile(),
      prisma.tradeAccount.count({ where: { ...scope, status: "PENDING_APPROVAL" } }),
      prisma.tradeAccount.count({ where: { ...scope, status: "APPROVED" } }),
      prisma.order.count({ where: { status: "PENDING_APPROVAL", tradeAccount: scope } }),
      prisma.order.count({ where: { status: { in: ["SUBMITTED", "CONFIRMED", "PART_SHIPPED"] }, tradeAccount: scope } }),
      prisma.quote.count({ where: { status: { in: ["REQUESTED", "IN_REVIEW"] }, tradeAccount: scope } }),
      ctx.user.role === "ADMIN" ? prisma.securityIncident.count({ where: { resolvedAt: null } }) : Promise.resolve(0),
      prisma.auditLog.findMany({
        where: ctx.user.role === "ADMIN" ? {} : { accountId: { in: (await prisma.tradeAccount.findMany({ where: scope, select: { id: true } })).map((a) => a.id) } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);
    const actors = new Map((await prisma.user.findMany({ where: { id: { in: recent.map((r) => r.actorId).filter((x): x is string => !!x) } } })).map((u) => [u.id, u.fullName]));
    return {
      business: profile.name,
      currency: profile.currency,
      me: { id: ctx.user.id, name: ctx.user.fullName, email: ctx.user.email, role: ctx.user.role },
      counts: { pendingApplications: pending, activeAccounts: approved, ordersAwaitingApproval: ordersAwaiting, openOrders, openQuotes, openIncidents: incidents },
      activity: recent.map((r) => ({ id: String(r.id), action: r.action, actor: r.actorId ? actors.get(r.actorId) ?? "Someone" : "System", target: r.target, at: r.createdAt.toISOString() })),
    };
  });

  // ───────────── trade accounts ─────────────
  app.get<{ Querystring: { status?: string; q?: string } }>("/v1/admin/accounts", async (req) => {
    const ctx = await requireStaff(req);
    const status = req.query.status && req.query.status !== "ALL" ? (req.query.status as AccountStatus) : undefined;
    const q = req.query.q?.trim();
    const accounts = await prisma.tradeAccount.findMany({
      where: {
        ...accountScope(ctx),
        ...(status ? { status } : {}),
        ...(q ? { OR: [{ legalName: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { users: { some: { email: { contains: q, mode: "insensitive" } } } }] } : {}),
      },
      include: accountInclude,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 300,
    });
    const bal = await balances(accounts.map((a) => a.id));
    return { accounts: accounts.map((a) => accountRow(a, bal.get(a.id) ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/accounts/:id", async (req) => {
    const ctx = await requireStaff(req);
    await assertAccountAccess(ctx, req.params.id);
    const a = await prisma.tradeAccount.findUniqueOrThrow({ where: { id: req.params.id }, include: accountInclude });
    const [bal, prices, ledger, devices, invites] = await Promise.all([
      balances([a.id]),
      prisma.accountPrice.findMany({ where: { tradeAccountId: a.id }, include: { product: true }, orderBy: [{ product: { sku: "asc" } }, { minQty: "asc" }] }),
      prisma.ledgerEntry.findMany({ where: { tradeAccountId: a.id }, orderBy: { postedAt: "desc" }, take: 50 }),
      prisma.device.findMany({ where: { user: { tradeAccountId: a.id } }, include: { user: true, release: true }, orderBy: { createdAt: "desc" } }),
      prisma.invite.findMany({ where: { tradeAccountId: a.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return {
      account: accountRow(a, bal.get(a.id) ?? 0),
      users: a.users.map((u) => ({ id: u.id, name: u.fullName, email: u.email, owner: u.isAccountOwner, active: u.active, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })),
      pendingInvites: invites.map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt.toISOString() })),
      prices: prices.map((p) => ({ id: p.id, sku: p.product.sku, name: p.product.name, minQty: p.minQty, unitMinor: n(p.unitMinor), listMinor: n(p.product.listMinor), validTo: p.validTo?.toISOString() ?? null })),
      ledger: ledger.map((l) => ({ id: l.id, kind: l.kind, reference: l.reference, amountMinor: n(l.amountMinor), postedAt: l.postedAt.toISOString(), dueAt: l.dueAt?.toISOString() ?? null })),
      devices: devices.map((d) => ({ id: d.id, label: d.label, user: d.user.fullName, status: d.status, version: d.release?.version ?? "unknown", lastAttestedAt: d.lastAttestedAt?.toISOString() ?? null })),
    };
  });

  const Terms = z.object({
    priceTierId: z.string().uuid().nullable().optional(),
    creditLimitMinor: Money.optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    repId: z.string().uuid().nullable().optional(),
    legalName: z.string().trim().min(2).max(160).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  });

  async function applyTerms(tx: Tx, id: string, t: z.infer<typeof Terms>) {
    await tx.tradeAccount.update({
      where: { id },
      data: {
        ...(t.priceTierId !== undefined ? { priceTierId: t.priceTierId } : {}),
        ...(t.creditLimitMinor !== undefined ? { creditLimitMinor: BigInt(t.creditLimitMinor) } : {}),
        ...(t.paymentTermsDays !== undefined ? { paymentTermsDays: t.paymentTermsDays } : {}),
        ...(t.legalName !== undefined ? { legalName: t.legalName } : {}),
        ...(t.phone !== undefined ? { phone: t.phone } : {}),
      },
    });
    if (t.repId !== undefined) {
      await tx.repAssignment.deleteMany({ where: { tradeAccountId: id } });
      if (t.repId) {
        const rep = await tx.user.findFirst({ where: { id: t.repId, role: { in: ["SALES_REP", "ADMIN"] }, active: true } });
        if (!rep) throw new HttpError(422, "REP_NOT_FOUND");
        await tx.repAssignment.create({ data: { repId: rep.id, tradeAccountId: id } });
      }
    }
  }

  /** Approve an application: set commercial terms, attach the catalogue, notify the applicant. */
  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/approve", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const t = Terms.parse(req.body ?? {});
    const acct = await prisma.$transaction(async (tx) => {
      const a = await tx.tradeAccount.findUniqueOrThrow({ where: { id: req.params.id } });
      if (a.status === "APPROVED") throw new HttpError(409, "ALREADY_APPROVED");
      await applyTerms(tx, a.id, t);
      const cat = await defaultCatalogue(tx);
      const updated = await tx.tradeAccount.update({
        where: { id: a.id },
        data: { status: "APPROVED", statusReason: null, approvedAt: new Date(), catalogueId: a.catalogueId ?? cat.id },
        include: { users: true },
      });
      await audit(tx, ctx, req, "account.approve", a.code, a.id, t);
      return updated;
    });
    for (const u of acct.users) {
      await notify(u.email, "Your trade account is approved", [`Hello ${u.fullName},`, "", `${acct.legalName} (${acct.code}) is now approved. Sign in to start ordering at your account prices.`]);
    }
    return { ok: true };
  });

  for (const action of ["reject", "suspend", "reactivate"] as const) {
    app.post<{ Params: { id: string } }>(`/v1/admin/accounts/:id/${action}`, async (req) => {
      const ctx = await requireStaff(req, { admin: true });
      const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
      const status: AccountStatus = action === "reject" ? "REJECTED" : action === "suspend" ? "SUSPENDED" : "APPROVED";
      const acct = await prisma.$transaction(async (tx) => {
        const a = await tx.tradeAccount.update({ where: { id: req.params.id }, data: { status, statusReason: action === "reactivate" ? null : reason ?? null }, include: { users: true } });
        // Suspended / rejected accounts lose their sessions immediately.
        if (status !== "APPROVED") await tx.webSession.updateMany({ where: { revokedAt: null, user: { tradeAccountId: a.id } }, data: { revokedAt: new Date() } });
        await audit(tx, ctx, req, `account.${action}`, a.code, a.id, { reason });
        return a;
      });
      if (action === "reject") {
        for (const u of acct.users) await notify(u.email, "Your trade account application", [`Hello ${u.fullName},`, "", `We're unable to open a trade account for ${acct.legalName} at this time.`, reason ? `Reason: ${reason}` : ""]);
      }
      return { ok: true };
    });
  }

  app.patch<{ Params: { id: string } }>("/v1/admin/accounts/:id", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const t = Terms.parse(req.body);
    await prisma.$transaction(async (tx) => {
      await applyTerms(tx, req.params.id, t);
      await audit(tx, ctx, req, "account.update", req.params.id, req.params.id, t);
    });
    return { ok: true };
  });

  /** Admin opens an account directly (phone/in-person sales) and invites its first buyer. */
  app.post("/v1/admin/accounts", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const body = Terms.extend({
      legalName: z.string().trim().min(2).max(160),
      ownerName: z.string().trim().min(2).max(120),
      ownerEmail: z.string().email().max(254),
    }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.ownerEmail.toLowerCase() } })) throw new HttpError(409, "EMAIL_IN_USE");
    const result = await prisma.$transaction(async (tx) => {
      const cat = await defaultCatalogue(tx);
      const a = await tx.tradeAccount.create({
        data: { code: `ACC-${(randomBytes(3).readUIntBE(0, 3) % 90000) + 10000}`, legalName: body.legalName, phone: body.phone ?? null, status: "APPROVED", approvedAt: new Date(), catalogueId: cat.id, currency: (await businessProfile(tx)).currency },
      });
      await applyTerms(tx, a.id, body);
      const invite = await createInvite(tx, { email: body.ownerEmail, fullName: body.ownerName, role: "TRADE_CUSTOMER", tradeAccountId: a.id, invitedById: ctx.user.id });
      await audit(tx, ctx, req, "account.create", a.code, a.id);
      return { id: a.id, code: a.code, invite };
    });
    await notify(body.ownerEmail, "You're invited to your trade account", [`Hello ${body.ownerName},`, "", `A trade account has been opened for ${body.legalName}. Set your password here:`, `  ${result.invite.url}`]);
    return { id: result.id, code: result.code, inviteUrl: result.invite.url };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/invites", async (req) => {
    const ctx = await requireStaff(req);
    const a = await assertAccountAccess(ctx, req.params.id);
    const body = z.object({ email: z.string().email(), fullName: z.string().trim().max(120).optional() }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })) throw new HttpError(409, "EMAIL_IN_USE");
    const invite = await prisma.$transaction(async (tx) => {
      const i = await createInvite(tx, { email: body.email, fullName: body.fullName, role: "TRADE_CUSTOMER", tradeAccountId: a.id, invitedById: ctx.user.id });
      await audit(tx, ctx, req, "account.invite_user", body.email, a.id);
      return i;
    });
    await notify(body.email, `Join ${a.legalName} on the trade portal`, ["You've been invited to order on this trade account. Set your password here:", `  ${invite.url}`]);
    return { inviteUrl: invite.url };
  });

  /** Contract (negotiated) prices per account. */
  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/prices", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const body = z.object({ sku: z.string().min(1), minQty: z.number().int().min(1).default(1), unitMinor: Money, validTo: z.string().datetime().nullable().optional() }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { sku: body.sku.toUpperCase() } });
      if (!product) throw new HttpError(422, "UNKNOWN_SKU");
      const existing = await tx.accountPrice.findFirst({ where: { tradeAccountId: req.params.id, productId: product.id, minQty: body.minQty } });
      if (existing) {
        await tx.accountPrice.update({ where: { id: existing.id }, data: { unitMinor: BigInt(body.unitMinor), validTo: body.validTo ? new Date(body.validTo) : null } });
      } else {
        await tx.accountPrice.create({
          data: { tradeAccountId: req.params.id, productId: product.id, minQty: body.minQty, unitMinor: BigInt(body.unitMinor), validTo: body.validTo ? new Date(body.validTo) : null, createdById: ctx.user.id },
        });
      }
      await bumpProducts(tx, [product.id]);
      await audit(tx, ctx, req, "price.contract_set", body.sku, req.params.id, body);
    });
    return { ok: true };
  });

  app.delete<{ Params: { priceId: string } }>("/v1/admin/prices/:priceId", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    await prisma.$transaction(async (tx) => {
      const p = await tx.accountPrice.delete({ where: { id: req.params.priceId } });
      await bumpProducts(tx, [p.productId]);
      await audit(tx, ctx, req, "price.contract_remove", p.id, p.tradeAccountId);
    });
    return { ok: true };
  });

  /** Statement entries: payments received, credit notes, manual invoices, adjustments. */
  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/ledger", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const body = z
      .object({ kind: z.enum(["INVOICE", "PAYMENT", "CREDIT_NOTE", "ADJUSTMENT"]), reference: z.string().trim().min(1).max(64), amountMinor: Money, dueAt: z.string().datetime().optional(), increase: z.boolean().optional() })
      .parse(req.body);
    // Positive = owed by the customer. Payments and credit notes reduce the balance.
    const sign = body.kind === "PAYMENT" || body.kind === "CREDIT_NOTE" || (body.kind === "ADJUSTMENT" && !body.increase) ? -1n : 1n;
    await prisma.$transaction(async (tx) => {
      const a = await tx.tradeAccount.findUniqueOrThrow({ where: { id: req.params.id } });
      await tx.ledgerEntry.create({
        data: {
          tradeAccountId: a.id,
          kind: body.kind,
          reference: body.reference,
          amountMinor: sign * BigInt(body.amountMinor),
          dueAt: body.kind === "INVOICE" ? (body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + a.paymentTermsDays * 86_400_000)) : null,
        },
      });
      await audit(tx, ctx, req, "ledger.post", body.reference, a.id, body);
    });
    return { ok: true };
  });

  /** Security override for a locked account (false positive). Audited. */
  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/unlock", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const a = await tx.tradeAccount.findUniqueOrThrow({ where: { id: req.params.id } });
      if ((a.securityState as SecurityState) === "ACTIVE") throw new HttpError(409, "NOT_LOCKED");
      await applySecurityEvent(tx, a.id, { type: "ADMIN_OVERRIDE_UNLOCK", adminId: ctx.user.id, reason }, { actorId: ctx.user.id, ip: req.ip });
      await tx.securityIncident.updateMany({ where: { tradeAccountId: a.id, resolvedAt: null }, data: { resolvedAt: new Date() } });
    });
    return { ok: true };
  });

  // ───────────── order for this customer ─────────────
  /** The customer's catalogue with their own price breaks, for staff placing an order for them. */
  app.get<{ Params: { id: string } }>("/v1/admin/accounts/:id/catalogue", async (req) => {
    const ctx = await requireStaff(req);
    const a = await assertAccountAccess(ctx, req.params.id);
    const items = await catalogueFor(prisma, a.id, { active: true });
    return { catalogue: items.map(({ syncVersion: _v, id: _id, active: _a, ...c }) => c) };
  });

  /**
   * Staff places an order on the customer's behalf: same prices, same credit check (over-limit
   * orders still need approval), channel REP, placed by the staff member. The account's buyers
   * are emailed so nothing arrives as a surprise.
   */
  app.post<{ Params: { id: string } }>("/v1/admin/accounts/:id/orders", async (req) => {
    const ctx = await requireStaff(req);
    const a = await assertAccountAccess(ctx, req.params.id);
    if (a.status !== "APPROVED") throw new HttpError(409, "ACCOUNT_NOT_APPROVED");
    if (a.securityState !== "ACTIVE") throw new HttpError(423, "ACCOUNT_SECURITY_LOCK");
    const body = z
      .object({
        lines: z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(1_000_000) })).min(1).max(500),
        poNumber: z.string().trim().max(64).optional(),
        mode: z.enum(["submit", "draft"]).default("submit"),
      })
      .parse(req.body);
    const { order, status } = await prisma.$transaction((tx) =>
      createOrder(tx, { tradeAccountId: a.id, userId: ctx.user.id, channel: "REP", lines: body.lines, submit: body.mode === "submit", poNumber: body.poNumber }),
    );
    if (body.mode === "submit") {
      const buyers = await prisma.user.findMany({ where: { tradeAccountId: a.id, active: true } });
      for (const u of buyers) {
        await notify(u.email, `Order ${order.number} placed for ${a.legalName}`, [
          `Hello ${u.fullName},`,
          "",
          `${ctx.user.fullName} placed order ${order.number} on your account${body.poNumber ? ` (PO ${body.poNumber})` : ""}.`,
          status === "PENDING_APPROVAL" ? "It exceeds your credit limit, so it is awaiting approval." : "You can see it in your trade portal under Orders.",
        ]);
      }
    }
    return { number: order.number, status, totalMinor: Number(order.totalMinor) };
  });

  // ───────────── orders ─────────────
  app.get<{ Querystring: { status?: string; q?: string } }>("/v1/admin/orders", async (req) => {
    const ctx = await requireStaff(req);
    const status = req.query.status && req.query.status !== "ALL" ? (req.query.status as OrderStatus) : undefined;
    const q = req.query.q?.trim();
    const orders = await prisma.order.findMany({
      where: {
        tradeAccount: accountScope(ctx),
        status: status ?? { not: "DRAFT" },
        ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { poNumber: { contains: q, mode: "insensitive" } }, { tradeAccount: { legalName: { contains: q, mode: "insensitive" } } }] } : {}),
      },
      include: { tradeAccount: true, placedBy: true, lines: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return {
      orders: orders.map((o) => ({
        number: o.number,
        account: { id: o.tradeAccountId, code: o.tradeAccount.code, name: o.tradeAccount.legalName },
        poNumber: o.poNumber,
        channel: o.channel,
        placedBy: o.placedBy.fullName,
        placedAt: (o.submittedAt ?? o.createdAt).toISOString(),
        status: o.status,
        totalMinor: n(o.totalMinor),
        currency: o.tradeAccount.currency,
        next: orderFlow[o.status] ?? [],
        lines: o.lines.map((l) => ({ sku: l.product.sku, name: l.product.name, qty: l.qty, unitMinor: n(l.unitMinor), lineMinor: n(l.lineMinor), source: l.priceSource })),
      })),
    };
  });

  app.post<{ Params: { number: string } }>("/v1/admin/orders/:number/status", async (req) => {
    const ctx = await requireStaff(req);
    const { status } = z.object({ status: z.enum(["SUBMITTED", "CONFIRMED", "PART_SHIPPED", "SHIPPED", "INVOICED", "CANCELLED"]) }).parse(req.body);
    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { number: req.params.number }, include: { tradeAccount: true, placedBy: true } });
      if (!o) throw new HttpError(404, "ORDER_NOT_FOUND");
      await assertAccountAccess(ctx, o.tradeAccountId);
      if (!(orderFlow[o.status] ?? []).includes(status)) throw new HttpError(409, "INVALID_TRANSITION", `${o.status} → ${status}`);
      const updated = await tx.order.update({
        where: { id: o.id },
        data: { status, version: { increment: 1 }, ...(o.status === "PENDING_APPROVAL" && status === "SUBMITTED" ? { approvedById: ctx.user.id } : {}) },
      });
      if (status === "INVOICED") {
        await tx.ledgerEntry.create({
          data: { tradeAccountId: o.tradeAccountId, kind: "INVOICE", reference: `INV-${o.number.slice(-8)}`, amountMinor: o.totalMinor, dueAt: new Date(Date.now() + o.tradeAccount.paymentTermsDays * 86_400_000) },
        });
      }
      await audit(tx, ctx, req, `order.${status.toLowerCase()}`, o.number, o.tradeAccountId);
      return { ...updated, email: o.placedBy.email, name: o.placedBy.fullName };
    });
    await notify(order.email, `Order ${order.number} update`, [`Hello ${order.name},`, "", `Order ${order.number} is now: ${status.replace(/_/g, " ").toLowerCase()}.`]);
    return { ok: true };
  });

  // ───────────── quotes ─────────────
  app.get<{ Querystring: { status?: string } }>("/v1/admin/quotes", async (req) => {
    const ctx = await requireStaff(req);
    const status = req.query.status && req.query.status !== "ALL" ? (req.query.status as QuoteStatus) : undefined;
    const quotes = await prisma.quote.findMany({
      where: { tradeAccount: accountScope(ctx), ...(status ? { status } : {}) },
      include: { tradeAccount: true, requestedBy: true, lines: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return {
      quotes: quotes.map((q) => ({
        number: q.number,
        account: { id: q.tradeAccountId, code: q.tradeAccount.code, name: q.tradeAccount.legalName },
        requestedBy: q.requestedBy.fullName,
        status: q.status,
        notes: q.notes,
        validUntil: q.validUntil?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
        currency: q.tradeAccount.currency,
        lines: q.lines.map((l) => ({ id: l.id, sku: l.product.sku, name: l.product.name, qty: l.qty, listMinor: n(l.product.listMinor), offeredMinor: l.offeredMinor === null ? null : n(l.offeredMinor) })),
      })),
    };
  });

  app.post<{ Params: { number: string } }>("/v1/admin/quotes/:number/offer", async (req) => {
    const ctx = await requireStaff(req);
    const body = z.object({ validDays: z.number().int().min(1).max(180), lines: z.array(z.object({ id: z.string().uuid(), offeredMinor: Money })).min(1) }).parse(req.body);
    const q = await prisma.$transaction(async (tx) => {
      const quote = await tx.quote.findUnique({ where: { number: req.params.number }, include: { lines: true, requestedBy: true } });
      if (!quote) throw new HttpError(404, "QUOTE_NOT_FOUND");
      await assertAccountAccess(ctx, quote.tradeAccountId);
      if (!["REQUESTED", "IN_REVIEW", "OFFERED"].includes(quote.status)) throw new HttpError(409, "QUOTE_CLOSED");
      const ids = new Set(quote.lines.map((l) => l.id));
      for (const l of body.lines) {
        if (!ids.has(l.id)) throw new HttpError(422, "UNKNOWN_LINE");
        await tx.quoteLine.update({ where: { id: l.id }, data: { offeredMinor: BigInt(l.offeredMinor) } });
      }
      await tx.quote.update({ where: { id: quote.id }, data: { status: "OFFERED", handledById: ctx.user.id, validUntil: new Date(Date.now() + body.validDays * 86_400_000) } });
      await audit(tx, ctx, req, "quote.offer", quote.number, quote.tradeAccountId);
      return quote;
    });
    await notify(q.requestedBy.email, `Your quote ${q.number} is ready`, [`Hello ${q.requestedBy.fullName},`, "", `Prices for quote ${q.number} are ready. Sign in to review and accept it (valid ${body.validDays} days).`]);
    return { ok: true };
  });

  for (const [action, status] of [["review", "IN_REVIEW"], ["decline", "DECLINED"]] as const) {
    app.post<{ Params: { number: string } }>(`/v1/admin/quotes/:number/${action}`, async (req) => {
      const ctx = await requireStaff(req);
      await prisma.$transaction(async (tx) => {
        const quote = await tx.quote.findUnique({ where: { number: req.params.number } });
        if (!quote) throw new HttpError(404, "QUOTE_NOT_FOUND");
        await assertAccountAccess(ctx, quote.tradeAccountId);
        if (!["REQUESTED", "IN_REVIEW", "OFFERED"].includes(quote.status)) throw new HttpError(409, "QUOTE_CLOSED");
        await tx.quote.update({ where: { id: quote.id }, data: { status, handledById: ctx.user.id } });
        await audit(tx, ctx, req, `quote.${action}`, quote.number, quote.tradeAccountId);
      });
      return { ok: true };
    });
  }

  // ───────────── catalogue & tier pricing ─────────────
  app.get("/v1/admin/products", async (req) => {
    await requireStaff(req);
    const [products, tiers] = await Promise.all([
      prisma.product.findMany({ include: { tierPrices: true }, orderBy: { sku: "asc" } }),
      prisma.priceTier.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { accounts: true } } } }),
    ]);
    return {
      tiers: tiers.map((t) => ({ id: t.id, name: t.name, accounts: t._count.accounts })),
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        uom: p.uom,
        packSize: p.packSize,
        listMinor: n(p.listMinor),
        stock: p.stockQty,
        active: p.active,
        tierPrices: p.tierPrices.map((t) => ({ tierId: t.tierId, minQty: t.minQty, unitMinor: n(t.unitMinor) })),
      })),
    };
  });

  const ProductBody = z.object({
    sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only"),
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    uom: z.string().trim().min(1).max(12).default("EA"),
    packSize: z.number().int().min(1).max(100000).default(1),
    listMinor: Money,
    stock: z.number().int().min(0).max(100_000_000).default(0),
    active: z.boolean().default(true),
  });

  app.post("/v1/admin/products", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const b = ProductBody.parse(req.body);
    const sku = b.sku.toUpperCase();
    if (await prisma.product.findUnique({ where: { sku } })) throw new HttpError(409, "SKU_EXISTS");
    const product = await prisma.$transaction(async (tx) => {
      const cat = await defaultCatalogue(tx);
      const p = await tx.product.create({
        data: { sku, name: b.name, description: b.description ?? null, uom: b.uom.toUpperCase(), packSize: b.packSize, listMinor: BigInt(b.listMinor), stockQty: b.stock, active: b.active, syncVersion: await nextSyncVersion(tx) },
      });
      await tx.catalogueProduct.create({ data: { catalogueId: cat.id, productId: p.id } });
      await audit(tx, ctx, req, "product.create", sku);
      return p;
    });
    return { id: product.id };
  });

  app.patch<{ Params: { id: string } }>("/v1/admin/products/:id", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const b = ProductBody.partial().omit({ sku: true }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      const p = await tx.product.update({
        where: { id: req.params.id },
        data: {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.uom !== undefined ? { uom: b.uom.toUpperCase() } : {}),
          ...(b.packSize !== undefined ? { packSize: b.packSize } : {}),
          ...(b.listMinor !== undefined ? { listMinor: BigInt(b.listMinor) } : {}),
          ...(b.stock !== undefined ? { stockQty: b.stock } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
          syncVersion: await nextSyncVersion(tx),
        },
      });
      await audit(tx, ctx, req, "product.update", p.sku, null, b);
    });
    return { ok: true };
  });

  app.post("/v1/admin/tiers", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const { name } = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body);
    if (await prisma.priceTier.findUnique({ where: { name } })) throw new HttpError(409, "TIER_EXISTS");
    const t = await prisma.priceTier.create({ data: { name } });
    await audit(prisma, ctx, req, "tier.create", name);
    return { id: t.id };
  });

  /** Replace one product's quantity-break ladder for one tier. */
  app.put<{ Params: { id: string } }>("/v1/admin/products/:id/tier-prices", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const body = z.object({ tierId: z.string().uuid(), breaks: z.array(z.object({ minQty: z.number().int().min(1), unitMinor: Money })).max(20) }).parse(req.body);
    await prisma.$transaction(async (tx) => {
      await tx.tierPrice.deleteMany({ where: { tierId: body.tierId, productId: req.params.id } });
      const seen = new Set<number>();
      for (const b of body.breaks) {
        if (seen.has(b.minQty)) continue;
        seen.add(b.minQty);
        await tx.tierPrice.create({ data: { tierId: body.tierId, productId: req.params.id, minQty: b.minQty, unitMinor: BigInt(b.unitMinor) } });
      }
      await bumpProducts(tx, [req.params.id]);
      await audit(tx, ctx, req, "price.tier_set", req.params.id, null, body);
    });
    return { ok: true };
  });

  // ───────────── team ─────────────
  app.get("/v1/admin/team", async (req) => {
    await requireStaff(req, { admin: true });
    const [staff, invites] = await Promise.all([
      prisma.user.findMany({ where: { role: { in: ["ADMIN", "SALES_REP"] } }, include: { mfaFactors: { where: { confirmedAt: { not: null } } }, _count: { select: { repAssignments: true } } }, orderBy: { fullName: "asc" } }),
      prisma.invite.findMany({ where: { tradeAccountId: null, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      staff: staff.map((u) => ({ id: u.id, name: u.fullName, email: u.email, role: u.role, active: u.active, mfa: u.mfaFactors.length > 0, accounts: u._count.repAssignments, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
    };
  });

  app.get("/v1/admin/reps", async (req) => {
    await requireStaff(req);
    const reps = await prisma.user.findMany({ where: { role: { in: ["SALES_REP", "ADMIN"] }, active: true }, orderBy: { fullName: "asc" } });
    return { reps: reps.map((r) => ({ id: r.id, name: r.fullName, role: r.role })) };
  });

  app.post("/v1/admin/team/invites", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const body = z.object({ email: z.string().email(), fullName: z.string().trim().max(120).optional(), role: z.enum(["ADMIN", "SALES_REP"]) }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })) throw new HttpError(409, "EMAIL_IN_USE");
    const invite = await prisma.$transaction(async (tx) => {
      const i = await createInvite(tx, { email: body.email, fullName: body.fullName, role: body.role as Role, invitedById: ctx.user.id });
      await audit(tx, ctx, req, "team.invite", body.email, null, { role: body.role });
      return i;
    });
    await notify(body.email, "You're invited to the admin portal", [`${ctx.user.fullName} invited you as ${body.role === "ADMIN" ? "an administrator" : "an account manager"}. Set your password here:`, `  ${invite.url}`]);
    return { inviteUrl: invite.url };
  });

  app.delete<{ Params: { id: string } }>("/v1/admin/invites/:id", async (req) => {
    const ctx = await requireStaff(req);
    const i = await prisma.invite.findUniqueOrThrow({ where: { id: req.params.id } });
    if (i.tradeAccountId) await assertAccountAccess(ctx, i.tradeAccountId);
    else if (ctx.user.role !== "ADMIN") throw new HttpError(403, "ADMIN_ONLY");
    await prisma.invite.update({ where: { id: i.id }, data: { revokedAt: new Date() } });
    await audit(prisma, ctx, req, "invite.revoke", i.email, i.tradeAccountId);
    return { ok: true };
  });

  for (const active of [false, true]) {
    app.post<{ Params: { id: string } }>(`/v1/admin/users/:id/${active ? "reactivate" : "deactivate"}`, async (req) => {
      const ctx = await requireStaff(req, { admin: true });
      if (req.params.id === ctx.user.id) throw new HttpError(409, "CANNOT_CHANGE_SELF");
      await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { id: req.params.id }, data: { active } });
        if (!active) {
          await tx.webSession.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
          if (u.role === "ADMIN" && (await tx.user.count({ where: { role: "ADMIN", active: true } })) === 0) throw new HttpError(409, "LAST_ADMIN");
        }
        await audit(tx, ctx, req, active ? "user.reactivate" : "user.deactivate", u.email, u.tradeAccountId);
      });
      return { ok: true };
    });
  }

  /** Lost authenticator: remove the user's 2-step factors and sign them out everywhere. They
   *  sign in to the web portal with their password and set up a new authenticator. */
  app.post<{ Params: { id: string } }>("/v1/admin/users/:id/reset-mfa", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    if (req.params.id === ctx.user.id) throw new HttpError(409, "CANNOT_CHANGE_SELF");
    const u = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: req.params.id } });
      await tx.mfaFactor.deleteMany({ where: { userId: user.id } });
      await tx.webSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, ctx, req, "user.reset_mfa", user.email, user.tradeAccountId);
      return user;
    });
    await notify(u.email, "Two-step verification was reset", [`Hello ${u.fullName},`, "", "An administrator reset two-step verification on your account. Sign in to the web portal with your password to set up your authenticator app again."]);
    return { ok: true };
  });

  // ───────────── security ─────────────
  app.get("/v1/admin/security", async (req) => {
    await requireStaff(req, { admin: true });
    const [devices, incidents, releases] = await Promise.all([
      prisma.device.findMany({ include: { user: { include: { tradeAccount: true } }, release: true }, orderBy: { createdAt: "desc" }, take: 300 }),
      prisma.securityIncident.findMany({ include: { tradeAccount: true }, orderBy: { openedAt: "desc" }, take: 100 }),
      prisma.desktopRelease.findMany({ orderBy: { publishedAt: "desc" }, include: { _count: { select: { devices: true } } } }),
    ]);
    return {
      devices: devices.map((d) => ({ id: d.id, label: d.label, user: d.user.fullName, account: d.user.tradeAccount?.legalName ?? "Staff", status: d.status, version: d.release?.version ?? "unknown", lastAttestedAt: d.lastAttestedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() })),
      incidents: incidents.map((i) => ({ id: i.id, account: { id: i.tradeAccountId, name: i.tradeAccount.legalName, state: i.tradeAccount.securityState }, kind: i.kind, openedAt: i.openedAt.toISOString(), resolvedAt: i.resolvedAt?.toISOString() ?? null })),
      releases: releases.map((r) => ({ id: r.id, buildId: r.buildId, version: r.version, platform: r.platform, publishedAt: r.publishedAt.toISOString(), revokedAt: r.revokedAt?.toISOString() ?? null, devices: r._count.devices })),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/devices/:id/revoke", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    await prisma.$transaction(async (tx) => {
      const d = await tx.device.update({ where: { id: req.params.id }, data: { status: "RETIRED" }, include: { user: true } });
      await tx.deviceCertificate.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "ADMIN_REVOKED" } });
      await audit(tx, ctx, req, "device.revoke", d.label, d.user.tradeAccountId);
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/releases/:id/revoke", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const r = await prisma.desktopRelease.update({ where: { id: req.params.id }, data: { revokedAt: new Date() } });
    await audit(prisma, ctx, req, "release.revoke", r.buildId);
    return { ok: true };
  });

  // ───────────── settings & audit ─────────────
  app.get("/v1/admin/settings", async (req) => {
    await requireStaff(req, { admin: true });
    const p = await businessProfile();
    return { name: p.name, supportEmail: p.supportEmail, currency: p.currency };
  });

  app.patch("/v1/admin/settings", async (req) => {
    const ctx = await requireStaff(req, { admin: true });
    const b = z.object({ name: z.string().trim().min(2).max(160).optional(), supportEmail: z.string().email().nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).parse(req.body);
    await businessProfile();
    await prisma.businessProfile.update({ where: { id: 1 }, data: b });
    await audit(prisma, ctx, req, "settings.update", undefined, null, b);
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/admin/audit", async (req) => {
    await requireStaff(req, { admin: true });
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(Number(req.query.limit ?? 200), 500) });
    const users = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } } })).map((u) => [u.id, u.fullName]));
    return { entries: rows.map((r) => ({ id: String(r.id), at: r.createdAt.toISOString(), actor: r.actorId ? users.get(r.actorId) ?? "Unknown" : "System", role: r.actorRole, action: r.action, target: r.target, ip: r.ip })) };
  });
}
