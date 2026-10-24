import { randomBytes } from "node:crypto";
import type { Order, OrderChannel, User } from "@prisma/client";
import { HttpError } from "./auth.js";
import type { Tx } from "./db.js";
import { openBalanceMinor, resolveUnitPrice } from "./pricing.js";
import { emit } from "./webhooks.js";

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

/** Account owners and nominated approvers sign off colleagues' orders above their spend limit. */
export const isOrderApprover = (u: Pick<User, "isAccountOwner" | "canApproveOrders">): boolean => u.isAccountOwner || u.canApproveOrders;

/** Supplier-side credit check: over the account's limit goes to the account manager. */
export async function creditStatus(tx: Tx, tradeAccountId: string, totalMinor: bigint): Promise<"SUBMITTED" | "PENDING_APPROVAL"> {
  const account = await tx.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId } });
  return (await openBalanceMinor(tx, account.id)) + totalMinor > account.creditLimitMinor ? "PENDING_APPROVAL" : "SUBMITTED";
}

/**
 * Single order-creation path for web, desktop sync and rep channels. Prices are always resolved
 * here. Two approval gates, in order:
 *   1. buyer side: a buyer's order above their personal spend limit waits for an approver on
 *      their own account (AWAITING_BUYER_APPROVAL);
 *   2. supplier side: over the account's credit limit goes to the account manager (PENDING_APPROVAL).
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
  // Desktop orders may have been written offline before the rule existed; they are never dropped.
  if (args.submit && account.poRequired && !args.poNumber?.trim() && args.channel !== "DESKTOP") {
    throw new HttpError(422, "PO_REQUIRED", "This account requires a purchase order number on every order.");
  }
  const user = await tx.user.findUniqueOrThrow({ where: { id: args.userId } });
  const overSpendLimit =
    user.role === "TRADE_CUSTOMER" && !isOrderApprover(user) && user.spendLimitMinor !== null && subtotal > user.spendLimitMinor;
  const status = !args.submit ? "DRAFT" : overSpendLimit ? "AWAITING_BUYER_APPROVAL" : await creditStatus(tx, account.id, subtotal);

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

/** Integration event for a placed order (call after the transaction commits). */
export function emitOrder(order: Pick<Order, "number" | "status" | "channel" | "poNumber" | "totalMinor" | "tradeAccountId">, event: "order.submitted" | "order.status" = "order.submitted"): void {
  if (order.status === "DRAFT") return;
  emit(event, { number: order.number, status: order.status, channel: order.channel, poNumber: order.poNumber, totalMinor: Number(order.totalMinor), tradeAccountId: order.tradeAccountId });
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
