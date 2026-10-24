import type { Prisma, Role } from "@prisma/client";
import { prisma, type Tx } from "./db.js";
import { paymentsConfig } from "./payments.js";

/**
 * Read models shared by the web portal (/v1/portal/dashboard) and the desktop snapshot
 * (/v1/sync/snapshot), so both clients render identical numbers. Money is minor units as JS
 * numbers (safe below 2^53, i.e. ~90 trillion pounds).
 */

type PriceSource = "ACCOUNT" | "TIER" | "LIST";
export interface Break {
  minQty: number;
  unitMinor: number;
  source: PriceSource;
}

const n = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** Price breaks for every product visible to an account, in one pass (no N+1). */
export async function catalogueFor(db: Tx | typeof prisma, tradeAccountId: string, where: Prisma.ProductWhereInput = {}) {
  const account = await db.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId } });
  const products = await db.product.findMany({
    where: {
      ...where,
      ...(account.catalogueId ? { catalogues: { some: { catalogueId: account.catalogueId } } } : {}),
    },
    orderBy: { sku: "asc" },
  });
  const ids = products.map((p) => p.id);
  const now = new Date();
  const [contract, tier, levels] = await Promise.all([
    db.accountPrice.findMany({
      where: { tradeAccountId, productId: { in: ids }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
      orderBy: [{ minQty: "asc" }, { validFrom: "desc" }],
    }),
    account.priceTierId
      ? db.tierPrice.findMany({ where: { tierId: account.priceTierId, productId: { in: ids } }, orderBy: { minQty: "asc" } })
      : Promise.resolve([]),
    stockByBranch(db, ids),
  ]);

  const group = <T extends { productId: string; minQty: number; unitMinor: bigint }>(rows: T[], source: PriceSource) => {
    const m = new Map<string, Break[]>();
    for (const r of rows) {
      const list = m.get(r.productId) ?? [];
      if (!list.some((b) => b.minQty === r.minQty)) list.push({ minQty: r.minQty, unitMinor: n(r.unitMinor), source });
      m.set(r.productId, list);
    }
    return m;
  };
  const contractBy = group(contract, "ACCOUNT");
  const tierBy = group(tier, "TIER");

  return products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    uom: p.uom,
    packSize: p.packSize,
    listMinor: n(p.listMinor),
    stock: p.stockQty,
    leadTimeDays: p.leadTimeDays,
    barcode: p.barcode,
    branches: levels.get(p.id) ?? [],
    active: p.active,
    syncVersion: p.syncVersion,
    // Contract prices replace the tier ladder entirely when present (that is the negotiation).
    breaks: contractBy.get(p.id) ?? tierBy.get(p.id) ?? [],
  }));
}

/** Per-warehouse availability for the given products (active warehouses only, display order). */
export async function stockByBranch(db: Tx | typeof prisma, productIds: string[]) {
  const rows = await db.stockLevel.findMany({
    where: { productId: { in: productIds }, warehouse: { active: true } },
    include: { warehouse: true },
    orderBy: [{ warehouse: { sortOrder: "asc" } }, { warehouse: { name: "asc" } }],
  });
  const m = new Map<string, Array<{ code: string; name: string; qty: number }>>();
  for (const r of rows) {
    const list = m.get(r.productId) ?? [];
    list.push({ code: r.warehouse.code, name: r.warehouse.name, qty: r.qty });
    m.set(r.productId, list);
  }
  return m;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Allocates credits/payments to the oldest invoices first, then buckets what is still open. */
function aging(entries: Array<{ kind: string; amountMinor: bigint; dueAt: Date | null; postedAt: Date }>) {
  let credit = entries.filter((e) => e.amountMinor < 0n).reduce((s, e) => s - n(e.amountMinor), 0);
  const invoices = entries
    .filter((e) => e.amountMinor > 0n)
    .sort((a, b) => (a.dueAt ?? a.postedAt).getTime() - (b.dueAt ?? b.postedAt).getTime());
  const buckets = [
    { label: "Current", amountMinor: 0 },
    { label: "1–30", amountMinor: 0 },
    { label: "31–60", amountMinor: 0 },
    { label: "60+", amountMinor: 0 },
  ];
  const now = Date.now();
  for (const inv of invoices) {
    let open = n(inv.amountMinor);
    const used = Math.min(open, credit);
    open -= used;
    credit -= used;
    if (open <= 0) continue;
    const overdue = Math.floor((now - (inv.dueAt ?? inv.postedAt).getTime()) / 86_400_000);
    const i = overdue <= 0 ? 0 : overdue <= 30 ? 1 : overdue <= 60 ? 2 : 3;
    buckets[i]!.amountMinor += open;
  }
  return buckets;
}

export async function buildDashboard(tradeAccountId: string, userId: string) {
  const [account, user, ledger, orders, quotes, devices] = await Promise.all([
    prisma.tradeAccount.findUniqueOrThrow({
      where: { id: tradeAccountId },
      include: { priceTier: true, reps: { include: { rep: true }, take: 1 } },
    }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { mfaFactors: { where: { confirmedAt: { not: null } } } } }),
    prisma.ledgerEntry.findMany({ where: { tradeAccountId }, orderBy: { postedAt: "desc" } }),
    prisma.order.findMany({
      where: { tradeAccountId },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { placedBy: true, lines: { include: { product: { select: { sku: true } } } } },
    }),
    prisma.quote.findMany({
      where: { tradeAccountId, status: { in: ["REQUESTED", "IN_REVIEW", "OFFERED"] } },
      orderBy: { createdAt: "desc" },
      include: { lines: true },
    }),
    prisma.device.findMany({
      where: { user: { tradeAccountId }, status: { not: "RETIRED" } },
      orderBy: { createdAt: "desc" },
      include: { release: true },
    }),
  ]);
  const payments = await prisma.payment.findMany({ where: { tradeAccountId, status: { in: ["SUCCEEDED", "PENDING"] } }, orderBy: { createdAt: "desc" }, take: 5 });

  const handlerIds = quotes.map((q) => q.handledById).filter((x): x is string => !!x);
  const handlers = new Map(
    (await prisma.user.findMany({ where: { id: { in: handlerIds } } })).map((u) => [u.id, u.fullName]),
  );
  const rep = account.reps[0]?.rep;
  const balance = ledger.reduce((s, e) => s + n(e.amountMinor), 0);

  return {
    account: {
      code: account.code,
      legalName: account.legalName,
      tier: account.priceTier?.name ?? "Standard",
      currency: account.currency,
      securityState: account.securityState,
      user: {
        name: user.fullName,
        email: user.email,
        role: user.role as Role,
        initials: initials(user.fullName),
        owner: user.isAccountOwner,
        canApprove: user.isAccountOwner || user.canApproveOrders,
        spendLimitMinor: user.spendLimitMinor === null ? null : n(user.spendLimitMinor),
      },
      rep: rep ? { name: rep.fullName, email: rep.email } : null,
      poRequired: account.poRequired,
    },
    payments: {
      ...paymentsConfig(),
      recent: payments.map((p) => ({ id: p.id, amountMinor: n(p.amountMinor), reference: p.reference, status: p.status, method: p.method, at: (p.completedAt ?? p.createdAt).toISOString() })),
    },
    mfaEnabled: user.mfaFactors.length > 0,
    credit: {
      limitMinor: n(account.creditLimitMinor),
      balanceMinor: balance,
      termsDays: account.paymentTermsDays,
      aging: aging(ledger),
    },
    orders: orders.map((o) => ({
      number: o.number,
      poNumber: o.poNumber,
      placedAt: (o.submittedAt ?? o.createdAt).toISOString(),
      channel: o.channel,
      placedBy: o.placedBy.fullName,
      lines: o.lines.length,
      items: o.lines.map((l) => ({ sku: l.product.sku, qty: l.qty })),
      totalMinor: n(o.totalMinor),
      status: o.status,
      placedById: o.placedById,
      tracking: o.trackingNumber || o.carrier ? { carrier: o.carrier, number: o.trackingNumber, url: o.trackingUrl, shippedAt: o.shippedAt?.toISOString() ?? null } : null,
    })),
    quotes: quotes.map((q) => ({
      number: q.number,
      status: q.status,
      lines: q.lines.length,
      offeredTotalMinor: q.status === "OFFERED" ? q.lines.reduce((s, l) => s + n(l.offeredMinor) * l.qty, 0) : null,
      validUntil: q.validUntil?.toISOString() ?? null,
      handler: q.handledById ? (handlers.get(q.handledById) ?? "Account team") : "Unassigned",
    })),
    ledger: ledger.slice(0, 8).map((l) => ({
      ref: l.reference,
      kind: l.kind,
      postedAt: l.postedAt.toISOString(),
      dueAt: l.dueAt?.toISOString() ?? null,
      amountMinor: n(l.amountMinor),
    })),
    devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      version: d.release?.version ?? "unknown",
      status: d.status,
      lastAttestedAt: d.lastAttestedAt?.toISOString() ?? null,
    })),
  };
}
