import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireTrade } from "../auth.js";
import { catalogueFor, buildDashboard } from "../portalData.js";
import { createOrder, createQuote } from "../orders.js";
import { HttpError } from "../auth.js";
import { randomBytes } from "node:crypto";

const Lines = z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(1_000_000) })).min(1).max(500);

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/portal/dashboard", async (req) => {
    const ctx = await requireTrade(req);
    const [dashboard, catalogue] = await Promise.all([
      buildDashboard(ctx.account!.id, ctx.user.id),
      catalogueFor(prisma, ctx.account!.id, { active: true }),
    ]);
    return { ...dashboard, catalogue: catalogue.map(({ syncVersion: _v, id: _id, active: _a, ...c }) => c) };
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
    return { number: order.number, status, totalMinor: Number(order.totalMinor) };
  });

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
      const balance = (await tx.ledgerEntry.aggregate({ where: { tradeAccountId: acct.id }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
      const status = balance + total > acct.creditLimitMinor ? "PENDING_APPROVAL" : "SUBMITTED";
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
    return { number: order.number, status: order.status, totalMinor: Number(order.totalMinor) };
  });
}
