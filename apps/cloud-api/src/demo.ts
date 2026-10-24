import { randomBytes } from "node:crypto";
import type { OrderStatus, OrderChannel } from "@prisma/client";
import { prisma } from "./db.js";
import { hashPassword } from "./lib/mfa.js";
import { nextSyncVersion } from "./stock.js";

/**
 * Sample data for sales demos: a plumbing & heating catalogue across three branches, three trade
 * accounts (two approved, one application waiting) with contract pricing, order history, quotes,
 * statements, saved lists and a buyer-approval example.
 *
 * Additive and idempotent: it never deletes anything and does nothing if the demo accounts
 * already exist, so it is safe on an install that already has its own admin. Used by the admin
 * portal ("Load demo data", DROPLET_DEMO=1) and `npm run db:demo` / `node dist/scripts/demo-data.js`.
 */

const days = (d: number) => new Date(Date.now() + d * 86_400_000);
const hours = (h: number) => new Date(Date.now() - h * 3_600_000);

/** EAN-13 with a valid check digit, from a 12-digit body. */
function ean13(body: string): string {
  const sum = body.split("").reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// sku, name, uom, pack, list (pence), stock [Leeds, Manchester, Birmingham], lead time days
const PRODUCTS: Array<[string, string, string, number, number, [number, number, number], number]> = [
  ["BV-1015", "Brass ball valve, lever, 15mm compression", "EA", 1, 1240, [520, 190, 102], 3],
  ["BV-1022", "Brass ball valve, lever, 22mm compression", "EA", 1, 1785, [210, 80, 50], 3],
  ["BV-1028", "Brass ball valve, lever, 28mm compression", "EA", 1, 2690, [60, 36, 0], 5],
  ["CU-T15-3M", "Copper tube, Table X, 15mm x 3m", "LEN", 10, 1460, [1400, 500, 300], 4],
  ["CU-T22-3M", "Copper tube, Table X, 22mm x 3m", "LEN", 10, 2830, [600, 240, 120], 4],
  ["CU-T28-3M", "Copper tube, Table X, 28mm x 3m", "LEN", 5, 3975, [280, 90, 40], 6],
  ["PF-E15-90", "Press-fit elbow 90 deg, 15mm, copper", "EA", 10, 342, [9800, 3600, 2000], 2],
  ["PF-E22-90", "Press-fit elbow 90 deg, 22mm, copper", "EA", 10, 518, [6200, 2400, 1200], 2],
  ["PF-T15", "Press-fit equal tee, 15mm, copper", "EA", 10, 489, [4600, 1600, 1000], 2],
  ["PF-T22", "Press-fit equal tee, 22mm, copper", "EA", 10, 715, [2600, 1000, 500], 2],
  ["PF-C15", "Press-fit straight coupler, 15mm", "EA", 10, 228, [13000, 5000, 3000], 2],
  ["PF-C22", "Press-fit straight coupler, 22mm", "EA", 10, 341, [8800, 3000, 2000], 2],
  ["TRV-15A", "Thermostatic radiator valve, angled, 15mm", "EA", 1, 2195, [80, 30, 18], 7],
  ["TRV-15S", "Thermostatic radiator valve, straight, 15mm", "EA", 1, 2195, [40, 24, 0], 7],
  ["LSV-15", "Lockshield valve, angled, 15mm", "EA", 1, 845, [240, 90, 50], 5],
  ["PTFE-12", "PTFE thread seal tape, 12mm x 12m", "RL", 10, 95, [18000, 7000, 5000], 2],
  ["FLX-SOL", "Lead-free solder wire, 500g", "EA", 1, 2840, [140, 50, 30], 5],
  ["FLX-PST", "Soldering flux paste, 100g", "EA", 1, 610, [340, 120, 80], 5],
  ["PI-MAG-22", "Inline magnetic system filter, 22mm", "EA", 1, 6450, [26, 10, 6], 10],
  ["EXP-18L", "Expansion vessel, 18L, wall mount", "EA", 1, 4825, [0, 0, 0], 14],
  ["EXP-24L", "Expansion vessel, 24L, wall mount", "EA", 1, 5690, [12, 6, 0], 14],
  ["PEX-16-50", "PEX-AL-PEX pipe, 16mm x 50m coil", "COIL", 1, 6940, [45, 20, 10], 10],
  ["INH-1L", "Central heating inhibitor, 1L", "EA", 1, 1890, [380, 140, 90], 3],
  ["CLN-1L", "Central heating cleaner, 1L", "EA", 1, 1650, [280, 110, 65], 3],
  ["CMB-30", "Combi boiler, 30kW, natural gas", "EA", 1, 98500, [4, 0, 2], 21],
  ["RAD-600-1000", "Compact radiator, type 22, 600 x 1000mm", "EA", 1, 11800, [18, 8, 0], 12],
];

const CONTRACT: Record<string, Array<[number, number]>> = {
  "BV-1015": [[1, 968], [25, 905], [100, 862]],
  "BV-1022": [[1, 1390], [25, 1310]],
  "PF-E15-90": [[1, 265], [200, 241]],
  "PF-E22-90": [[1, 402], [200, 371]],
  "PF-T22": [[1, 560]],
  "PI-MAG-22": [[1, 5390]],
  "INH-1L": [[1, 1490], [12, 1420]],
  "CMB-30": [[1, 84900]],
};
const TIER_DISCOUNT = 0.84;

export interface DemoResult {
  loaded: boolean;
  message: string;
  password?: string;
  logins?: Array<{ email: string; name: string; account: string; note: string }>;
}

export async function loadDemoData(opts: { password?: string; repId?: string } = {}): Promise<DemoResult> {
  if (await prisma.tradeAccount.findUnique({ where: { code: "ACC-10442" } })) {
    return { loaded: false, message: "Demo data is already loaded." };
  }
  const password = opts.password ?? process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(4).toString("hex")}!`;
  const passwordHash = await hashPassword(password);

  // Branches. Reuse the default MAIN warehouse (created by the migration) as the Leeds DC.
  let main = await prisma.warehouse.upsert({ where: { code: "MAIN" }, create: { code: "MAIN", name: "Leeds distribution centre", sortOrder: 0 }, update: {} });
  if (main.name === "Main warehouse") main = await prisma.warehouse.update({ where: { id: main.id }, data: { name: "Leeds distribution centre" } });
  const man = await prisma.warehouse.upsert({ where: { code: "MAN" }, create: { code: "MAN", name: "Manchester branch", sortOrder: 1 }, update: {} });
  const bhm = await prisma.warehouse.upsert({ where: { code: "BHM" }, create: { code: "BHM", name: "Birmingham trade counter", sortOrder: 2 }, update: {} });
  const branches = [main.id, man.id, bhm.id];

  const tier = (await prisma.priceTier.findUnique({ where: { name: "Distributor B" } })) ?? (await prisma.priceTier.create({ data: { name: "Distributor B" } }));
  const catalogue = (await prisma.catalogue.findFirst({ orderBy: { updatedAt: "asc" } })) ?? (await prisma.catalogue.create({ data: { name: "Main catalogue" } }));

  const bySku = new Map<string, string>();
  let i = 0;
  for (const [sku, name, uom, packSize, list, stock, lead] of PRODUCTS) {
    i++;
    const total = stock.reduce((s, q) => s + q, 0);
    const barcode = ean13(`50123450${String(1000 + i).slice(-4)}`);
    const existing = await prisma.product.findUnique({ where: { sku } });
    const p =
      existing ??
      (await prisma.product.create({
        data: { sku, name, uom, packSize, listMinor: BigInt(list), stockQty: total, leadTimeDays: lead, barcode: (await prisma.product.findUnique({ where: { barcode } })) ? null : barcode, syncVersion: await prisma.$transaction((tx) => nextSyncVersion(tx)) },
      }));
    bySku.set(sku, p.id);
    if (!existing) {
      await prisma.catalogueProduct.create({ data: { catalogueId: catalogue.id, productId: p.id, sortOrder: i } });
      await prisma.stockLevel.createMany({ data: stock.map((qty, b) => ({ warehouseId: branches[b]!, productId: p.id, qty })) });
      await prisma.tierPrice.createMany({
        data: [
          { tierId: tier.id, productId: p.id, minQty: 1, unitMinor: BigInt(Math.round(list * TIER_DISCOUNT)) },
          { tierId: tier.id, productId: p.id, minQty: 50, unitMinor: BigInt(Math.round(list * TIER_DISCOUNT * 0.95)) },
        ],
      });
    }
  }

  const repId =
    opts.repId ??
    (
      (await prisma.user.findFirst({ where: { role: "SALES_REP", active: true } })) ??
      (await prisma.user.findFirst({ where: { role: "ADMIN", active: true } })) ??
      (await prisma.user.create({ data: { email: "tom.lindqvist@droplet-demo.example", fullName: "Tom Lindqvist", role: "SALES_REP", passwordHash } }))
    ).id;

  // ── Account 1: Northgate, multi-user with a buyer spend limit ──
  const northgate = await prisma.tradeAccount.create({
    data: { code: "ACC-10442", legalName: "Northgate Mechanical Services Ltd", phone: "0113 496 0412", status: "APPROVED", approvedAt: days(-400), priceTierId: tier.id, catalogueId: catalogue.id, creditLimitMinor: 5_000_000n, paymentTermsDays: 30 },
  });
  await prisma.repAssignment.create({ data: { repId, tradeAccountId: northgate.id } });
  const priya = await prisma.user.create({ data: { email: "priya@northgate.example", fullName: "Priya Okafor", role: "TRADE_CUSTOMER", tradeAccountId: northgate.id, isAccountOwner: true, canApproveOrders: true, passwordHash } });
  const dan = await prisma.user.create({ data: { email: "dan@northgate.example", fullName: "Dan Mercer", role: "TRADE_CUSTOMER", tradeAccountId: northgate.id, spendLimitMinor: 150_000n, passwordHash } });
  await prisma.user.create({ data: { email: "sam@northgate.example", fullName: "Sam Achebe", role: "TRADE_CUSTOMER", tradeAccountId: northgate.id, spendLimitMinor: 50_000n, passwordHash } });
  for (const [sku, ladder] of Object.entries(CONTRACT)) {
    for (const [minQty, pence] of ladder) {
      await prisma.accountPrice.create({ data: { tradeAccountId: northgate.id, productId: bySku.get(sku)!, minQty, unitMinor: BigInt(pence), validFrom: days(-200), contractRef: "NMS-2026-A", createdById: repId } });
    }
  }

  // ── Account 2: Brightwater, standard pricing, PO numbers required ──
  const brightwater = await prisma.tradeAccount.create({
    data: { code: "ACC-20518", legalName: "Brightwater Heating & Plumbing", phone: "0161 496 0733", status: "APPROVED", approvedAt: days(-120), catalogueId: catalogue.id, creditLimitMinor: 1_500_000n, paymentTermsDays: 30, poRequired: true },
  });
  await prisma.repAssignment.create({ data: { repId, tradeAccountId: brightwater.id } });
  const leah = await prisma.user.create({ data: { email: "leah@brightwater.example", fullName: "Leah Brennan", role: "TRADE_CUSTOMER", tradeAccountId: brightwater.id, isAccountOwner: true, canApproveOrders: true, passwordHash } });

  // ── Account 3: an application waiting for approval ──
  const kestrel = await prisma.tradeAccount.create({ data: { code: "ACC-30077", legalName: "Kestrel Building Supplies", phone: "0121 496 0190", status: "PENDING_APPROVAL" } });
  await prisma.user.create({ data: { email: "omar@kestrel.example", fullName: "Omar Haddad", role: "TRADE_CUSTOMER", tradeAccountId: kestrel.id, isAccountOwner: true, canApproveOrders: true, passwordHash } });
  await prisma.auditLog.create({ data: { actorRole: "TRADE_CUSTOMER", accountId: kestrel.id, action: "account.apply", target: kestrel.code, meta: { email: "omar@kestrel.example", company: kestrel.legalName }, createdAt: hours(5) } });

  // ── Orders (prices from the same contract/tier ladders the API uses) ──
  const unit = (accountId: string, sku: string, qty: number) => {
    const list = PRODUCTS.find((p) => p[0] === sku)![4];
    if (accountId === northgate.id) {
      const c = CONTRACT[sku]?.filter(([m]) => qty >= m).at(-1);
      if (c) return { p: c[1], src: "ACCOUNT" };
      return { p: Math.round(list * TIER_DISCOUNT * (qty >= 50 ? 0.95 : 1)), src: "TIER" };
    }
    return { p: list, src: "LIST" };
  };
  type Hist = { acct: string; po: string | null; h: number; ch: OrderChannel; by: string; status: OrderStatus; lines: Array<[string, number]>; track?: [string, string, string] };
  const history: Hist[] = [
    { acct: northgate.id, po: "PO-77812", h: 3, ch: "DESKTOP", by: priya.id, status: "SUBMITTED", lines: [["PF-E15-90", 400], ["CU-T15-3M", 60], ["BV-1015", 48], ["PTFE-12", 40]] },
    { acct: northgate.id, po: "PO-77815", h: 1, ch: "WEB", by: dan.id, status: "AWAITING_BUYER_APPROVAL", lines: [["CMB-30", 2], ["PI-MAG-22", 2], ["INH-1L", 4]] },
    { acct: northgate.id, po: "PO-77809", h: 26, ch: "WEB", by: dan.id, status: "CONFIRMED", lines: [["TRV-15A", 24], ["LSV-15", 24], ["INH-1L", 12]] },
    { acct: northgate.id, po: null, h: 30, ch: "REP", by: repId, status: "PENDING_APPROVAL", lines: [["PEX-16-50", 40], ["EXP-24L", 10], ["PI-MAG-22", 12]] },
    { acct: northgate.id, po: "PO-77790", h: 74, ch: "DESKTOP", by: priya.id, status: "SHIPPED", lines: [["CU-T22-3M", 80], ["PF-E22-90", 250], ["PF-T22", 60]], track: ["DPD", "15501234567890", "https://track.dpd.co.uk/parcels/15501234567890"] },
    { acct: northgate.id, po: "PO-77771", h: 140, ch: "WEB", by: dan.id, status: "INVOICED", lines: [["FLX-SOL", 6], ["FLX-PST", 12]], track: ["Own van", "LDS-RUN-0412", ""] },
    { acct: brightwater.id, po: "BW-3301", h: 20, ch: "WEB", by: leah.id, status: "SUBMITTED", lines: [["RAD-600-1000", 6], ["TRV-15A", 12], ["LSV-15", 12]] },
    { acct: brightwater.id, po: "BW-3288", h: 96, ch: "WEB", by: leah.id, status: "SHIPPED", lines: [["CU-T15-3M", 20], ["PF-E15-90", 100], ["PF-C15", 100]], track: ["Royal Mail Tracked 48", "TT123456789GB", "https://www.royalmail.com/track-your-item#/tracking-results/TT123456789GB"] },
  ];
  for (const o of history) {
    const lines = o.lines.map(([sku, qty]) => {
      const u = unit(o.acct, sku, qty);
      return { productId: bySku.get(sku)!, qty, unitMinor: BigInt(u.p), lineMinor: BigInt(u.p * qty), priceSource: u.src };
    });
    const total = lines.reduce((s, l) => s + l.lineMinor, 0n);
    const shipped = o.track ? { carrier: o.track[0], trackingNumber: o.track[1], trackingUrl: o.track[2] || null, shippedAt: hours(Math.max(o.h - 20, 1)) } : {};
    await prisma.order.create({
      data: {
        number: `DL-${new Date().getFullYear()}-${randomBytes(4).toString("hex").toUpperCase()}`,
        poNumber: o.po,
        tradeAccountId: o.acct,
        status: o.status,
        channel: o.ch,
        placedById: o.by,
        subtotalMinor: total,
        totalMinor: total,
        submittedAt: hours(o.h),
        createdAt: hours(o.h),
        ...shipped,
        lines: { create: lines },
      },
    });
  }

  const quote = async (accountId: string, by: string, number: string, status: "REQUESTED" | "IN_REVIEW" | "OFFERED", items: Array<[string, number, number?]>, validDays?: number) =>
    prisma.quote.create({
      data: {
        number,
        tradeAccountId: accountId,
        status,
        requestedById: by,
        handledById: status === "REQUESTED" ? null : repId,
        validUntil: validDays ? days(validDays) : null,
        lines: { create: items.map(([sku, qty, offered]) => ({ productId: bySku.get(sku)!, qty, offeredMinor: offered === undefined ? null : BigInt(offered) })) },
      },
    });
  await quote(northgate.id, priya.id, "QT-4410", "OFFERED", [["PEX-16-50", 120, 5650], ["PF-C15", 2000, 168], ["PF-C22", 1500, 252]], 5);
  await quote(northgate.id, priya.id, "QT-4417", "IN_REVIEW", [["EXP-18L", 30], ["EXP-24L", 30]]);
  await quote(brightwater.id, leah.id, "QT-4421", "REQUESTED", [["BV-1028", 200]]);

  await prisma.ledgerEntry.createMany({
    data: [
      { tradeAccountId: northgate.id, kind: "INVOICE", reference: "INV-209102", amountMinor: 4_120_000n, postedAt: days(-75), dueAt: days(-45) },
      { tradeAccountId: northgate.id, kind: "INVOICE", reference: "INV-209511", amountMinor: 318_220n, postedAt: days(-33), dueAt: days(-3) },
      { tradeAccountId: northgate.id, kind: "PAYMENT", reference: "PAY-55102", amountMinor: -1_500_000n, postedAt: days(-2) },
      { tradeAccountId: northgate.id, kind: "CREDIT_NOTE", reference: "CN-01877", amountMinor: -12_640n, postedAt: days(-4) },
      { tradeAccountId: northgate.id, kind: "INVOICE", reference: "INV-209874", amountMinor: 41_760n, postedAt: days(-6), dueAt: days(24) },
      { tradeAccountId: northgate.id, kind: "INVOICE", reference: "INV-209931", amountMinor: 96_480n, postedAt: days(-1), dueAt: days(29) },
      { tradeAccountId: brightwater.id, kind: "INVOICE", reference: "INV-210044", amountMinor: 268_350n, postedAt: days(-40), dueAt: days(-10) },
      { tradeAccountId: brightwater.id, kind: "INVOICE", reference: "INV-210190", amountMinor: 92_400n, postedAt: days(-8), dueAt: days(22) },
    ],
  });

  const list = async (accountId: string, by: string, name: string, note: string | null, items: Array<[string, number]>, usedDaysAgo?: number) =>
    prisma.orderList.create({
      data: {
        tradeAccountId: accountId,
        name,
        note,
        createdById: by,
        lastUsedAt: usedDaysAgo === undefined ? null : days(-usedDaysAgo),
        items: { create: items.map(([sku, qty], idx) => ({ productId: bySku.get(sku)!, qty, sortOrder: idx })) },
      },
    });
  await list(northgate.id, dan.id, "Van restock (weekly)", "Dan's van, every Monday", [["PF-E15-90", 50], ["PF-E22-90", 30], ["PF-C15", 50], ["PF-C22", 30], ["PTFE-12", 10], ["FLX-PST", 2]], 6);
  await list(northgate.id, priya.id, "Boiler swap kit", "Standard combi replacement", [["CMB-30", 1], ["PI-MAG-22", 1], ["INH-1L", 1], ["CLN-1L", 1], ["BV-1022", 2]], 13);
  await list(northgate.id, priya.id, "Site: Holbeck Mills phase 2", "First-fix, 12 flats", [["CU-T15-3M", 120], ["CU-T22-3M", 60], ["PF-E15-90", 600], ["PF-T15", 240], ["BV-1015", 24]]);
  await list(brightwater.id, leah.id, "Radiator install", null, [["RAD-600-1000", 1], ["TRV-15A", 1], ["LSV-15", 1], ["PTFE-12", 1]], 3);

  return {
    loaded: true,
    message: "Demo data loaded: 3 branches, 26 products, 3 trade accounts.",
    password,
    logins: [
      { email: "priya@northgate.example", name: "Priya Okafor", account: "Northgate Mechanical", note: "Account owner and approver; contract prices" },
      { email: "dan@northgate.example", name: "Dan Mercer", account: "Northgate Mechanical", note: "Buyer, £1,500 spend limit (orders above need Priya)" },
      { email: "leah@brightwater.example", name: "Leah Brennan", account: "Brightwater Heating", note: "Standard prices, PO number required" },
      { email: "omar@kestrel.example", name: "Omar Haddad", account: "Kestrel Building Supplies", note: "Application waiting for approval" },
    ],
  };
}
