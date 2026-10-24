import { createHmac } from "node:crypto";
import { prisma } from "./db.js";

/**
 * Outbound integration events for accounting / ERP connectors (Xero, Sage, QuickBooks via a
 * middleware such as Zapier, Make or a small sync service).
 *
 *   POST <webhookUrl>
 *   X-Droplet-Event:     order.submitted | order.status | invoice.created | payment.succeeded | test
 *   X-Droplet-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>" with the webhook secret>
 *
 * Delivery is best effort with two retries; the integration API (GET /v1/integration/...) is the
 * source of truth for reconciliation, so a missed event is never data loss.
 */

export type WebhookEvent = "order.submitted" | "order.status" | "invoice.created" | "payment.succeeded" | "test";

export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export async function deliverWebhook(event: WebhookEvent, data: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  const profile = await prisma.businessProfile.findUnique({ where: { id: 1 } });
  if (!profile?.webhookUrl || !profile.webhookSecret) return { ok: false, error: "NOT_CONFIGURED" };
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  let last: { ok: boolean; status?: number; error?: string } = { ok: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(profile.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-droplet-event": event, "x-droplet-signature": signWebhook(profile.webhookSecret, body) },
        body,
        signal: AbortSignal.timeout(8000),
      });
      last = { ok: res.ok, status: res.status };
      if (res.ok) return last;
    } catch (e) {
      last = { ok: false, error: (e as Error).message };
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  console.error(`[webhook] ${event} delivery failed`, last);
  return last;
}

/** Fire-and-forget from request handlers. */
export function emit(event: WebhookEvent, data: unknown): void {
  void deliverWebhook(event, data).catch((e) => console.error("[webhook]", e));
}
