import { createHmac } from "node:crypto";
import type { Payment } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { HttpError } from "./auth.js";
import { safeEqual } from "./lib/crypto.js";
import { notify } from "./onboarding.js";
import { emit } from "./webhooks.js";

/**
 * Online payment of statement balances and invoices.
 *
 *  - Stripe Checkout (STRIPE_SECRET_KEY): card and, for GBP, Bacs Direct Debit. Stripe hosts the
 *    payment page, so card data never touches DROPLET. Completion arrives by webhook
 *    (STRIPE_WEBHOOK_SECRET) and is also confirmed when the buyer returns to the portal.
 *  - Demo provider (PAYMENTS_DEMO=1): a simulated checkout for demo installs. No money moves and
 *    the page says so; never enable it on a live install.
 *
 * A successful payment posts a PAYMENT line to the statement, which reduces the balance and
 * frees credit immediately.
 */

export type PaymentProvider = "stripe" | "demo";

export function paymentsConfig(): { enabled: boolean; provider: PaymentProvider | null; methods: string[] } {
  if (config.stripeSecretKey) return { enabled: true, provider: "stripe", methods: config.stripeMethods };
  if (config.paymentsDemo) return { enabled: true, provider: "demo", methods: ["card", "bacs_debit"] };
  return { enabled: false, provider: null, methods: [] };
}

async function stripe<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { authorization: `Bearer ${config.stripeSecretKey}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new HttpError(502, "PAYMENT_PROVIDER_ERROR", data.error?.message ?? `Stripe HTTP ${res.status}`);
  return data;
}

interface StripeSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_method_types?: string[];
}

/** Starts a payment and returns where to send the buyer. */
export async function startPayment(args: { tradeAccountId: string; userId: string; email: string; amountMinor: bigint; currency: string; reference: string }): Promise<{ id: string; url: string }> {
  const cfg = paymentsConfig();
  if (!cfg.enabled || !cfg.provider) throw new HttpError(409, "PAYMENTS_DISABLED");
  const payment = await prisma.payment.create({
    data: { tradeAccountId: args.tradeAccountId, amountMinor: args.amountMinor, currency: args.currency, provider: cfg.provider, reference: args.reference, createdById: args.userId },
  });
  if (cfg.provider === "demo") return { id: payment.id, url: `/pay/demo/${payment.id}` };

  const back = `${config.portalOrigin}/app/statements`;
  const methods = cfg.methods.filter((m) => m !== "bacs_debit" || args.currency.toUpperCase() === "GBP");
  const form: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": args.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(args.amountMinor),
    "line_items[0][price_data][product_data][name]": args.reference,
    success_url: `${back}?payment=${payment.id}`,
    cancel_url: `${back}?payment=${payment.id}&cancelled=1`,
    client_reference_id: payment.id,
    "metadata[paymentId]": payment.id,
    "payment_intent_data[metadata][paymentId]": payment.id,
    customer_email: args.email,
  };
  methods.forEach((m, i) => (form[`payment_method_types[${i}]`] = m));
  const session = await stripe<StripeSession>("POST", "/v1/checkout/sessions", form);
  await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: session.id } });
  return { id: payment.id, url: session.url ?? back };
}

/** Marks a payment succeeded exactly once and posts it to the statement. */
export async function completePayment(paymentId: string, method: string | null): Promise<Payment> {
  const result = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.status === "SUCCEEDED") return { payment: p, fresh: false };
    const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "SUCCEEDED", method: method ?? p.method, completedAt: new Date() } });
    await tx.ledgerEntry.create({
      data: { tradeAccountId: p.tradeAccountId, kind: "PAYMENT", reference: `PAY-${p.id.slice(0, 8).toUpperCase()}`, amountMinor: -p.amountMinor },
    });
    await tx.auditLog.create({ data: { actorId: p.createdById, accountId: p.tradeAccountId, action: "payment.succeeded", target: p.id, meta: { amountMinor: Number(p.amountMinor), provider: p.provider, method } } });
    return { payment: updated, fresh: true };
  });
  if (result.fresh) {
    const p = result.payment;
    const [user, account] = await Promise.all([
      prisma.user.findUnique({ where: { id: p.createdById } }),
      prisma.tradeAccount.findUnique({ where: { id: p.tradeAccountId } }),
    ]);
    const amount = (Number(p.amountMinor) / 100).toFixed(2);
    if (user) await notify(user.email, "Payment received", [`Hello ${user.fullName},`, "", `Thank you. We received your payment of ${amount} ${p.currency} (${p.reference}). It now shows on your statement.`]);
    emit("payment.succeeded", { id: p.id, account: account?.code, amountMinor: Number(p.amountMinor), currency: p.currency, reference: p.reference, method: p.method, provider: p.provider, completedAt: p.completedAt });
  }
  return result.payment;
}

export async function failPayment(paymentId: string, status: "FAILED" | "CANCELLED"): Promise<void> {
  await prisma.payment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status } });
}

/** Re-checks a Stripe payment with Stripe (used when the buyer returns from checkout). */
export async function refreshPayment(p: Payment): Promise<Payment> {
  if (p.status !== "PENDING" || p.provider !== "stripe" || !p.providerRef || !config.stripeSecretKey) return p;
  const s = await stripe<StripeSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(p.providerRef)}`);
  if (s.payment_status === "paid") return completePayment(p.id, s.payment_method_types?.[0] ?? null);
  if (s.status === "expired") await failPayment(p.id, "CANCELLED");
  return prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

/** Verifies a Stripe-Signature header against the raw request body. */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .some((kv) => safeEqual(kv.slice(3), expected));
}
