import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../auth.js";
import { readToken } from "../lib/signedToken.js";
import { buildDashboard, catalogueFor } from "../portalData.js";
import { createOrder, createQuote } from "../orders.js";
import type { SyncClaims } from "./devices.js";

/**
 * Every sync call re-validates the full trust chain live (account state, device status,
 * certificate) so a lockout takes effect on the very next request, not at token expiry.
 */
async function requireSync(req: FastifyRequest): Promise<SyncClaims> {
  const auth = req.headers.authorization;
  const claims = auth?.startsWith("Bearer ") ? readToken<SyncClaims>("sync", auth.slice(7)) : null;
  if (!claims || !claims.tradeAccountId) throw new HttpError(401, "SYNC_TOKEN_INVALID");

  const [device, cert, account] = await Promise.all([
    prisma.device.findUnique({ where: { id: claims.deviceId } }),
    prisma.deviceCertificate.findUnique({ where: { serial: claims.certSerial } }),
    prisma.tradeAccount.findUnique({ where: { id: claims.tradeAccountId } }),
  ]);
  if (!device || device.status !== "TRUSTED" || !cert || cert.revokedAt || cert.deviceId !== device.id) {
    throw new HttpError(403, "DEVICE_REVOKED");
  }
  if (!account || account.securityState !== "ACTIVE") throw new HttpError(423, "ACCOUNT_SECURITY_LOCK");
  if (account.status !== "APPROVED") throw new HttpError(403, "ACCOUNT_SUSPENDED", account.status);
  const user = await prisma.user.findUnique({ where: { id: claims.userId } });
  if (!user?.active) throw new HttpError(403, "DEVICE_REVOKED");
  return claims;
}

const Line = z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(1_000_000) });

const PullBody = z.object({
  stream: z.literal("catalogue"),
  since: z.string().regex(/^\d+$/).default("0"),
  limit: z.number().int().min(1).max(2000).default(1000),
});

const PushBody = z.object({
  orders: z
    .array(
      z.object({
        clientRef: z.string().uuid(),
        poNumber: z.string().max(64).optional(),
        submit: z.boolean(),
        lines: z.array(Line).min(1).max(500),
      }),
    )
    .max(100),
});

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Cursor-based delta pull of the account's catalogue, each row carrying that account's price
   * breaks. The daemon loops until hasMore=false, committing rows + cursor atomically.
   */
  app.post("/v1/sync/pull", async (req) => {
    const claims = await requireSync(req);
    const { since, limit } = PullBody.parse(req.body);
    const cursor = BigInt(since);
    const page = (await catalogueFor(prisma, claims.tradeAccountId, { syncVersion: { gt: cursor } }))
      .sort((a, b) => (a.syncVersion < b.syncVersion ? -1 : a.syncVersion > b.syncVersion ? 1 : 0))
      .slice(0, limit);
    const maxVersion = page.reduce((m, p) => (p.syncVersion > m ? p.syncVersion : m), cursor);

    await prisma.syncCursor.upsert({
      where: { deviceId_stream: { deviceId: claims.deviceId, stream: "catalogue" } },
      create: { deviceId: claims.deviceId, stream: "catalogue", serverVersion: maxVersion },
      update: { serverVersion: maxVersion, lastSyncedAt: new Date() },
    });
    return {
      stream: "catalogue",
      rows: page.map(({ syncVersion: _v, ...p }) => p),
      nextCursor: String(maxVersion),
      hasMore: page.length === limit,
    };
  });

  /** Push queued desktop orders. Idempotent on (account, clientRef); prices re-resolved here. */
  app.post("/v1/sync/push", async (req) => {
    const claims = await requireSync(req);
    const { orders } = PushBody.parse(req.body);
    const results = [];
    for (const draft of orders) {
      const existing = await prisma.order.findUnique({
        where: { tradeAccountId_clientRef: { tradeAccountId: claims.tradeAccountId, clientRef: draft.clientRef } },
      });
      if (existing) {
        results.push({ clientRef: draft.clientRef, orderId: existing.id, number: existing.number, status: existing.status, duplicate: true });
        continue;
      }
      try {
        const { order, status, subtotal } = await prisma.$transaction((tx) =>
          createOrder(tx, {
            tradeAccountId: claims.tradeAccountId,
            userId: claims.userId,
            channel: "DESKTOP",
            lines: draft.lines,
            submit: draft.submit,
            poNumber: draft.poNumber,
            clientRef: draft.clientRef,
            deviceId: claims.deviceId,
          }),
        );
        results.push({ clientRef: draft.clientRef, orderId: order.id, number: order.number, status, totalMinor: String(subtotal) });
      } catch (e) {
        if (e instanceof HttpError && e.code === "UNKNOWN_SKU") {
          results.push({ clientRef: draft.clientRef, error: "UNKNOWN_SKU", skus: e.message.split(", ") });
        } else throw e;
      }
    }
    return { results };
  });

  /** Account read model for offline viewing on desktop (same shape as the web dashboard). */
  app.get("/v1/sync/snapshot", async (req) => {
    const claims = await requireSync(req);
    return buildDashboard(claims.tradeAccountId, claims.userId);
  });

  app.post("/v1/sync/quotes", async (req) => {
    const claims = await requireSync(req);
    const body = z.object({ lines: z.array(Line).min(1).max(500), notes: z.string().max(2000).nullish() }).parse(req.body);
    const quote = await prisma.$transaction((tx) =>
      createQuote(tx, { tradeAccountId: claims.tradeAccountId, userId: claims.userId, lines: body.lines, notes: body.notes }),
    );
    return { number: quote.number, status: quote.status };
  });
}
