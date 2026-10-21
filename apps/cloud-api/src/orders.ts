import { randomBytes } from "node:crypto";
import type { OrderChannel } from "@prisma/client";
import { HttpError } from "./auth.js";
import type { Tx } from "./db.js";
import { openBalanceMinor, resolveUnitPrice } from "./pricing.js";

export interface LineInput {
  sku: string;
  qty: number;
}

async function priceLines(tx: Tx, tradeAccountId: string, lines: LineInput[]) {
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.sku.toUpperCase(), (merged.get(l.sku.toUpperCase()) ?? 0) + l.qty);
  const products = await tx.product.findMany({ where: { sku: { in: [...merged.keys()] }, active: true } });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const unknown = [...merged.keys()].filter((s) => !bySku.has(s));
  if (unknown.length) throw new HttpError(422, "UNKNOWN_SKU", unknown.join(", "));

  const priced = [];
  let subtotal = 0n;
  for (const [sku, qty] of merged) {
    const product = bySku.get(sku)!;
    const price = await resolveUnitPrice(tx, tradeAccountId, product.id, qty);
    const lineMinor = price.unitMinor * BigInt(qty);
    subtotal += lineMinor;
    priced.push({ productId: product.id, qty, unitMinor: price.unitMinor, lineMinor, priceSource: price.source });
  }
  return { priced, subtotal };
}

/**
 * Single order-creation path for web, desktop sync and rep channels. Prices are always resolved
 * here; over-credit submissions are routed to the account manager for approval.
 */
export async function createOrder(
  tx: Tx,
  args: {
    tradeAccountId: string;
    userId: string;
    channel: OrderChannel;
    lines: LineInput[];
    submit: boolean;
    poNumber?: string | null;
    clientRef?: string;
    deviceId?: string;
  },
) {
  const { priced, subtotal } = await priceLines(tx, args.tradeAccountId, args.lines);
  const account = await tx.tradeAccount.findUniqueOrThrow({ where: { id: args.tradeAccountId } });
  const overCredit = (await openBalanceMinor(tx, account.id)) + subtotal > account.creditLimitMinor;
  const status = !args.submit ? "DRAFT" : overCredit ? "PENDING_APPROVAL" : "SUBMITTED";

  const order = await tx.order.create({
    data: {
      number: `DL-${new Date().getFullYear()}-${randomBytes(4).toString("hex").toUpperCase()}`,
      clientRef: args.clientRef ?? null,
      tradeAccountId: account.id,
      status,
      channel: args.channel,
      poNumber: args.poNumber || null,
      placedById: args.userId,
      sourceDeviceId: args.deviceId ?? null,
      subtotalMinor: subtotal,
      totalMinor: subtotal, // VAT is applied by the ERP on confirmation
      submittedAt: status === "DRAFT" ? null : new Date(),
      lines: { create: priced },
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: args.userId,
      accountId: account.id,
      action: `order.${args.channel.toLowerCase()}`,
      target: order.id,
      meta: { status, deviceId: args.deviceId ?? null },
    },
  });
  return { order, status, priced, subtotal };
}

export async function createQuote(tx: Tx, args: { tradeAccountId: string; userId: string; lines: LineInput[]; notes?: string | null }) {
  const skus = [...new Set(args.lines.map((l) => l.sku.toUpperCase()))];
  const products = await tx.product.findMany({ where: { sku: { in: skus }, active: true } });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const unknown = skus.filter((s) => !bySku.has(s));
  if (unknown.length) throw new HttpError(422, "UNKNOWN_SKU", unknown.join(", "));
  const rep = await tx.repAssignment.findFirst({ where: { tradeAccountId: args.tradeAccountId } });
  const quote = await tx.quote.create({
    data: {
      number: `QT-${randomBytes(3).toString("hex").toUpperCase()}`,
      tradeAccountId: args.tradeAccountId,
      requestedById: args.userId,
      handledById: rep?.repId ?? null,
      notes: args.notes ?? null,
      lines: { create: args.lines.map((l) => ({ productId: bySku.get(l.sku.toUpperCase())!.id, qty: l.qty })) },
    },
  });
  await tx.auditLog.create({
    data: { actorId: args.userId, accountId: args.tradeAccountId, action: "quote.request", target: quote.id },
  });
  return quote;
}
