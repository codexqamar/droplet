import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { HttpError } from "../auth.js";
import { sha256Hex } from "../lib/crypto.js";
import { completePayment, failPayment, verifyStripeSignature } from "../payments.js";
import { bumpProducts, defaultWarehouse, nextSyncVersion, setStock, warehousesByCode } from "../stock.js";
import { applyOrderStatus } from "./admin.js";

/**
 * Accounting / ERP integration API (Xero, Sage, QuickBooks, or an in-house ERP via a connector).
 * Authenticated with an API key created in the admin portal (Integrations): `Authorization:
 * Bearer dlk_...`. Catalogue, pricing and stock flow in; orders, invoices and payments flow out.
 * Changes are pushed as signed webhooks too (see webhooks.ts); these endpoints are the pull side
 * and the source of truth for reconciliation.
 */

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

async function requireApiKey(req: FastifyRequest) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("dlk_")) throw new HttpError(401, "API_KEY_REQUIRED");
  const key = await prisma.apiKey.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!key || key.revokedAt) throw new HttpError(401, "API_KEY_INVALID");
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key;
}

const since = (q: { since?: string }) => {
  const d = q.since ? new Date(q.since) : new Date(0);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "BAD_SINCE", "since must be an ISO-8601 timestamp");
  return d;
};

export const ProductUpsert = z.object({
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  barcode: z.string().trim().max(32).nullable().optional(),
  uom: z.string().trim().min(1).max(12).optional(),
  packSize: z.number().int().min(1).max(100000).optional(),
  listMinor: z.number().int().min(0).max(1_000_000_000_00).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
  /** Stock per warehouse code, e.g. { "MAIN": 120, "MAN": 40 }. Unknown codes are rejected. */
  stock: z.record(z.string(), z.number().int().min(0).max(100_000_000)).optional(),
});

/** Upserts products by SKU (used by the integration API and the admin CSV import). */
export async function upsertProducts(rows: Array<z.infer<typeof ProductUpsert>>): Promise<{ created: number; updated: number; errors: Array<{ sku: string; error: string }> }> {
  let created = 0;
  let updated = 0;
  const errors: Array<{ sku: string; error: string }> = [];
  for (const row of rows) {
    const sku = row.sku.toUpperCase();
    try {
      await prisma.$transaction(async (tx) => {
        const codes = await warehousesByCode(tx);
        const levels = Object.entries(row.stock ?? {}).map(([code, qty]) => {
          const warehouseId = codes.get(code.toUpperCase());
          if (!warehouseId) throw new HttpError(422, "UNKNOWN_WAREHOUSE", code);
          return { warehouseId, qty };
        });
        const existing = await tx.product.findUnique({ where: { sku } });
        const data = {
          ...(row.name !== undefined ? { name: row.name } : {}),
          ...(row.description !== undefined ? { description: row.description } : {}),
          ...(row.barcode !== undefined ? { barcode: row.barcode || null } : {}),
          ...(row.uom !== undefined ? { uom: row.uom.toUpperCase() } : {}),
          ...(row.packSize !== undefined ? { packSize: row.packSize } : {}),
          ...(row.listMinor !== undefined ? { listMinor: BigInt(row.listMinor) } : {}),
          ...(row.leadTimeDays !== undefined ? { leadTimeDays: row.leadTimeDays } : {}),
          ...(row.active !== undefined ? { active: row.active } : {}),
        };
        let productId: string;
        if (existing) {
          await tx.product.update({ where: { id: existing.id }, data: { ...data, syncVersion: await nextSyncVersion(tx) } });
          productId = existing.id;
          updated++;
        } else {
          if (!row.name || row.listMinor === undefined) throw new HttpError(422, "NEW_PRODUCT_NEEDS_NAME_AND_PRICE");
          const p = await tx.product.create({ data: { sku, name: row.name, listMinor: BigInt(row.listMinor), ...data, syncVersion: await nextSyncVersion(tx) } });
          const cat = (await tx.catalogue.findFirst({ orderBy: { updatedAt: "asc" } })) ?? (await tx.catalogue.create({ data: { name: "Main catalogue" } }));
          await tx.catalogueProduct.create({ data: { catalogueId: cat.id, productId: p.id } });
          if (!levels.length) levels.push({ warehouseId: (await defaultWarehouse(tx)).id, qty: 0 });
          productId = p.id;
          created++;
        }
        if (levels.length) await setStock(tx, productId, levels);
        else await bumpProducts(tx, [productId]);
      });
    } catch (e) {
      errors.push({ sku, error: e instanceof HttpError ? `${e.code}${e.message !== e.code ? `: ${e.message}` : ""}` : e instanceof Error && e.message.includes("Unique constraint") ? "BARCODE_IN_USE" : "FAILED" });
    }
  }
  return { created, updated, errors };
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  // ───────────── inbound: catalogue, pricing, stock ─────────────
  app.put("/v1/integration/products", async (req) => {
    await requireApiKey(req);
    const rows = z.array(ProductUpsert).min(1).max(5000).parse(req.body);
    return upsertProducts(rows);
  });

  app.put("/v1/integration/stock", async (req) => {
    await requireApiKey(req);
    const rows = z.array(z.object({ sku: z.string().min(1), warehouse: z.string().min(1), qty: z.number().int().min(0) })).min(1).max(20000).parse(req.body);
    const bySku = new Map<string, Record<string, number>>();
    for (const r of rows) bySku.set(r.sku.toUpperCase(), { ...(bySku.get(r.sku.toUpperCase()) ?? {}), [r.warehouse]: r.qty });
    const known = new Set((await prisma.product.findMany({ where: { sku: { in: [...bySku.keys()] } }, select: { sku: true } })).map((p) => p.sku));
    const result = await upsertProducts([...bySku].filter(([sku]) => known.has(sku)).map(([sku, stock]) => ({ sku, stock })));
    return { ...result, errors: [...result.errors, ...[...bySku.keys()].filter((s) => !known.has(s)).map((sku) => ({ sku, error: "UNKNOWN_SKU" }))] };
  });

  app.put("/v1/integration/contract-prices", async (req) => {
    const key = await requireApiKey(req);
    const rows = z
      .array(z.object({ account: z.string().min(1), sku: z.string().min(1), minQty: z.number().int().min(1).default(1), unitMinor: z.number().int().min(0), validTo: z.string().datetime().nullable().optional(), contractRef: z.string().max(64).optional() }))
      .min(1)
      .max(20000)
      .parse(req.body);
    let applied = 0;
    const errors: Array<{ account: string; sku: string; error: string }> = [];
    for (const r of rows) {
      const [acct, product] = await Promise.all([prisma.tradeAccount.findUnique({ where: { code: r.account } }), prisma.product.findUnique({ where: { sku: r.sku.toUpperCase() } })]);
      if (!acct || !product) {
        errors.push({ account: r.account, sku: r.sku, error: !acct ? "UNKNOWN_ACCOUNT" : "UNKNOWN_SKU" });
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const existing = await tx.accountPrice.findFirst({ where: { tradeAccountId: acct.id, productId: product.id, minQty: r.minQty } });
        const data = { unitMinor: BigInt(r.unitMinor), validTo: r.validTo ? new Date(r.validTo) : null, contractRef: r.contractRef ?? null };
        if (existing) await tx.accountPrice.update({ where: { id: existing.id }, data });
        else await tx.accountPrice.create({ data: { tradeAccountId: acct.id, productId: product.id, minQty: r.minQty, createdById: key.createdById, ...data } });
        await bumpProducts(tx, [product.id]);
      });
      applied++;
    }
    return { applied, errors };
  });

  // ───────────── outbound: orders, invoices, payments ─────────────
  app.get<{ Querystring: { since?: string } }>("/v1/integration/orders", async (req) => {
    await requireApiKey(req);
    const orders = await prisma.order.findMany({
      where: { updatedAt: { gt: since(req.query) }, status: { notIn: ["DRAFT"] } },
      include: { tradeAccount: true, placedBy: true, lines: { include: { product: true } } },
      orderBy: { updatedAt: "asc" },
      take: 500,
    });
    return {
      orders: orders.map((o) => ({
        number: o.number,
        account: { code: o.tradeAccount.code, name: o.tradeAccount.legalName },
        status: o.status,
        channel: o.channel,
        poNumber: o.poNumber,
        placedBy: o.placedBy.email,
        currency: o.tradeAccount.currency,
        subtotalMinor: n(o.subtotalMinor),
        totalMinor: n(o.totalMinor),
        submittedAt: o.submittedAt?.toISOString() ?? null,
        updatedAt: o.updatedAt.toISOString(),
        tracking: o.trackingNumber ? { carrier: o.carrier, number: o.trackingNumber, url: o.trackingUrl } : null,
        lines: o.lines.map((l) => ({ sku: l.product.sku, name: l.product.name, qty: l.qty, unitMinor: n(l.unitMinor), lineMinor: n(l.lineMinor), priceSource: l.priceSource })),
      })),
    };
  });

  /** ERP marks an order confirmed / shipped (with tracking) / invoiced. Same rules as the admin portal. */
  app.post<{ Params: { number: string } }>("/v1/integration/orders/:number/status", async (req) => {
    const key = await requireApiKey(req);
    const body = z
      .object({ status: z.enum(["CONFIRMED", "PART_SHIPPED", "SHIPPED", "INVOICED", "CANCELLED"]), carrier: z.string().max(60).optional(), trackingNumber: z.string().max(80).optional(), trackingUrl: z.string().url().max(500).optional() })
      .parse(req.body);
    await applyOrderStatus({ number: req.params.number, actorId: key.createdById, actorRole: "ADMIN", ip: req.ip, ...body });
    return { ok: true };
  });

  app.get<{ Querystring: { since?: string } }>("/v1/integration/invoices", async (req) => {
    await requireApiKey(req);
    const rows = await prisma.ledgerEntry.findMany({ where: { kind: { in: ["INVOICE", "CREDIT_NOTE"] }, postedAt: { gt: since(req.query) } }, include: { tradeAccount: true }, orderBy: { postedAt: "asc" }, take: 1000 });
    return { invoices: rows.map((r) => ({ reference: r.reference, kind: r.kind, account: r.tradeAccount.code, accountName: r.tradeAccount.legalName, currency: r.tradeAccount.currency, amountMinor: n(r.amountMinor), postedAt: r.postedAt.toISOString(), dueAt: r.dueAt?.toISOString() ?? null })) };
  });

  app.get<{ Querystring: { since?: string } }>("/v1/integration/payments", async (req) => {
    await requireApiKey(req);
    const rows = await prisma.payment.findMany({ where: { status: "SUCCEEDED", completedAt: { gt: since(req.query) } }, include: { tradeAccount: true }, orderBy: { completedAt: "asc" }, take: 1000 });
    return { payments: rows.map((p) => ({ id: p.id, account: p.tradeAccount.code, currency: p.currency, amountMinor: n(p.amountMinor), reference: p.reference, provider: p.provider, method: p.method, completedAt: p.completedAt?.toISOString() ?? null })) };
  });

  app.get("/v1/integration/accounts", async (req) => {
    await requireApiKey(req);
    const rows = await prisma.tradeAccount.findMany({ where: { status: "APPROVED" }, include: { priceTier: true }, orderBy: { code: "asc" } });
    return { accounts: rows.map((a) => ({ code: a.code, name: a.legalName, tier: a.priceTier?.name ?? null, currency: a.currency, creditLimitMinor: n(a.creditLimitMinor), paymentTermsDays: a.paymentTermsDays })) };
  });

  // ───────────── Stripe webhook (raw body for signature verification) ─────────────
  await app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/v1/payments/stripe/webhook", async (req, reply) => {
      if (!config.stripeWebhookSecret) return reply.status(404).send({ error: "NOT_CONFIGURED" });
      const raw = req.body as string;
      if (!verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, config.stripeWebhookSecret)) {
        return reply.status(400).send({ error: "BAD_SIGNATURE" });
      }
      const event = JSON.parse(raw) as { type: string; data: { object: { client_reference_id?: string; metadata?: { paymentId?: string }; payment_status?: string; payment_method_types?: string[] } } };
      const s = event.data.object;
      const paymentId = s.metadata?.paymentId ?? s.client_reference_id;
      if (paymentId && (await prisma.payment.findUnique({ where: { id: paymentId } }))) {
        const method = s.payment_method_types?.[0] ?? null;
        if ((event.type === "checkout.session.completed" && s.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded") await completePayment(paymentId, method);
        else if (event.type === "checkout.session.async_payment_failed") await failPayment(paymentId, "FAILED");
        else if (event.type === "checkout.session.expired") await failPayment(paymentId, "CANCELLED");
        else if (event.type === "checkout.session.completed") await prisma.payment.update({ where: { id: paymentId }, data: { method } });
      }
      return { received: true };
    });
  });
}
