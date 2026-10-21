/**
 * OPTIONAL demo data for local development (`npm run db:demo`). Not used by setup. WIPES every table except the desktop release registry (so installed builds
 * stay recognised), then loads one approved trade account with realistic
 * catalogue, contract pricing, orders, quotes and statement history.
 *
 *   npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { base32, encryptSecret, hashPassword, otpauthUri } from "../src/lib/mfa.js";

const prisma = new PrismaClient();
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "Droplet-Demo-2026!";
const days = (d: number) => new Date(Date.now() + d * 86_400_000);
const hours = (h: number) => new Date(Date.now() - h * 3_600_000);

const products: Array<[sku: string, name: string, uom: string, pack: number, listPence: number, stock: number]> = [
  ["BV-1015", "Brass ball valve, lever, 15mm compression", "EA", 1, 1240, 812],
  ["BV-1022", "Brass ball valve, lever, 22mm compression", "EA", 1, 1785, 340],
  ["BV-1028", "Brass ball valve, lever, 28mm compression", "EA", 1, 2690, 96],
  ["CU-T15-3M", "Copper tube, Table X, 15mm × 3m", "LEN", 10, 1460, 2200],
  ["CU-T22-3M", "Copper tube, Table X, 22mm × 3m", "LEN", 10, 2830, 960],
  ["CU-T28-3M", "Copper tube, Table X, 28mm × 3m", "LEN", 5, 3975, 410],
  ["PF-E15-90", "Press-fit elbow 90°, 15mm, copper", "EA", 10, 342, 15400],
  ["PF-E22-90", "Press-fit elbow 90°, 22mm, copper", "EA", 10, 518, 9800],
  ["PF-T15", "Press-fit equal tee, 15mm, copper", "EA", 10, 489, 7200],
  ["PF-T22", "Press-fit equal tee, 22mm, copper", "EA", 10, 715, 4100],
  ["PF-C15", "Press-fit straight coupler, 15mm", "EA", 10, 228, 21000],
  ["PF-C22", "Press-fit straight coupler, 22mm", "EA", 10, 341, 13800],
  ["TRV-15A", "Thermostatic radiator valve, angled, 15mm", "EA", 1, 2195, 128],
  ["TRV-15S", "Thermostatic radiator valve, straight, 15mm", "EA", 1, 2195, 64],
  ["LSV-15", "Lockshield valve, angled, 15mm", "EA", 1, 845, 380],
  ["PTFE-12", "PTFE thread seal tape, 12mm × 12m", "RL", 10, 95, 30000],
  ["FLX-SOL", "Lead-free solder wire, 500g", "EA", 1, 2840, 220],
  ["FLX-PST", "Soldering flux paste, 100g", "EA", 1, 610, 540],
  ["PI-MAG-22", "Inline magnetic system filter, 22mm", "EA", 1, 6450, 42],
  ["EXP-18L", "Expansion vessel, 18L, wall mount", "EA", 1, 4825, 0],
  ["EXP-24L", "Expansion vessel, 24L, wall mount", "EA", 1, 5690, 18],
  ["PEX-16-50", "PEX-AL-PEX pipe, 16mm × 50m coil", "COIL", 1, 6940, 75],
  ["INH-1L", "Central heating inhibitor, 1L", "EA", 1, 1890, 610],
  ["CLN-1L", "Central heating cleaner, 1L", "EA", 1, 1650, 455],
];

// Negotiated contract ladders for Northgate (pence). Products not listed fall back to the tier.
const contract: Record<string, Array<[minQty: number, pence: number]>> = {
  "BV-1015": [[1, 968], [25, 905], [100, 862]],
  "BV-1022": [[1, 1390], [25, 1310]],
  "PF-E15-90": [[1, 265], [200, 241]],
  "PF-E22-90": [[1, 402], [200, 371]],
  "PF-T22": [[1, 560]],
  "PI-MAG-22": [[1, 5390]],
  "INH-1L": [[1, 1490], [12, 1420]],
};
const tierDiscount = 0.84; // Distributor B: 16% off list, extra 5% at 50+

async function wipe() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'DesktopRelease')`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

async function main() {
  // This wipes business data. Never run it against an install a business is using.
  const profile = await prisma.businessProfile.findUnique({ where: { id: 1 } });
  if (profile?.setupCompletedAt && !process.argv.includes("--force")) {
    console.error("Refusing: this install has completed setup (real data). Use a separate dev database, or pass --force.");
    process.exit(1);
  }
  await wipe();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const tier = await prisma.priceTier.create({ data: { name: "Distributor B" } });
  await prisma.priceTier.create({ data: { name: "Standard" } });
  const catalogue = await prisma.catalogue.create({ data: { name: "Plumbing & Heating — Trade" } });

  const bySku = new Map<string, string>();
  let version = 0n;
  for (const [sku, name, uom, packSize, list, stock] of products) {
    version++;
    const p = await prisma.product.create({
      data: { sku, name, uom, packSize, listMinor: BigInt(list), stockQty: stock, syncVersion: version },
    });
    bySku.set(sku, p.id);
    await prisma.catalogueProduct.create({ data: { catalogueId: catalogue.id, productId: p.id } });
    await prisma.tierPrice.createMany({
      data: [
        { tierId: tier.id, productId: p.id, minQty: 1, unitMinor: BigInt(Math.round(list * tierDiscount)) },
        { tierId: tier.id, productId: p.id, minQty: 50, unitMinor: BigInt(Math.round(list * tierDiscount * 0.95)) },
      ],
    });
  }
  await prisma.syncSequence.create({ data: { id: 1, value: version } });

  const rep = await prisma.user.create({
    data: { email: "tom.lindqvist@droplet.example", fullName: "Tom Lindqvist", role: "SALES_REP", passwordHash },
  });
  await prisma.user.create({
    data: { email: "admin@droplet.example", fullName: "DROPLET Admin", role: "ADMIN", passwordHash },
  });

  const account = await prisma.tradeAccount.create({
    data: {
      code: "ACC-10442",
      legalName: "Northgate Mechanical Services Ltd",
      status: "APPROVED",
      approvedAt: days(-400),
      priceTierId: tier.id,
      catalogueId: catalogue.id,
      creditLimitMinor: 5_000_000n,
      paymentTermsDays: 30,
    },
  });
  await prisma.repAssignment.create({ data: { repId: rep.id, tradeAccountId: account.id } });

  const owner = await prisma.user.create({
    data: {
      email: "priya@northgate.example",
      fullName: "Priya Okafor",
      role: "TRADE_CUSTOMER",
      tradeAccountId: account.id,
      isAccountOwner: true,
      passwordHash,
    },
  });
  const buyer = await prisma.user.create({
    data: { email: "dan@northgate.example", fullName: "Dan Mercer", role: "TRADE_CUSTOMER", tradeAccountId: account.id, passwordHash },
  });
  const totpSecret = randomBytes(20);
  await prisma.mfaFactor.create({
    data: { userId: owner.id, kind: "TOTP", secretEnc: encryptSecret(totpSecret), label: "Authenticator app", confirmedAt: new Date() },
  });

  for (const [sku, ladder] of Object.entries(contract)) {
    for (const [minQty, pence] of ladder) {
      await prisma.accountPrice.create({
        data: {
          tradeAccountId: account.id,
          productId: bySku.get(sku)!,
          minQty,
          unitMinor: BigInt(pence),
          validFrom: days(-200),
          contractRef: "NMS-2026-A",
          createdById: rep.id,
        },
      });
    }
  }

  // Order history. Totals are computed from the same contract/tier ladders the API uses.
  const unit = (sku: string, qty: number) => {
    const c = contract[sku]?.filter(([m]) => qty >= m).at(-1);
    if (c) return { p: c[1], src: "ACCOUNT" };
    const list = products.find((p) => p[0] === sku)![4];
    return { p: Math.round(list * tierDiscount * (qty >= 50 ? 0.95 : 1)), src: "TIER" };
  };
  const history: Array<{ num: string; po: string | null; h: number; ch: "WEB" | "DESKTOP" | "REP"; by: string; status: "SUBMITTED" | "CONFIRMED" | "PENDING_APPROVAL" | "PART_SHIPPED" | "INVOICED"; lines: Array<[string, number]> }> = [
    { num: "DL-2026-8F21A0C3", po: "PO-77812", h: 3, ch: "DESKTOP", by: owner.id, status: "SUBMITTED", lines: [["PF-E15-90", 400], ["CU-T15-3M", 60], ["BV-1015", 48], ["PTFE-12", 40]] },
    { num: "DL-2026-1B90D4E7", po: "PO-77809", h: 26, ch: "WEB", by: buyer.id, status: "CONFIRMED", lines: [["TRV-15A", 24], ["LSV-15", 24], ["INH-1L", 12]] },
    { num: "DL-2026-C33E7712", po: null, h: 30, ch: "REP", by: rep.id, status: "PENDING_APPROVAL", lines: [["PEX-16-50", 40], ["EXP-24L", 10], ["PI-MAG-22", 12]] },
    { num: "DL-2026-0A5F19B2", po: "PO-77790", h: 74, ch: "DESKTOP", by: owner.id, status: "PART_SHIPPED", lines: [["CU-T22-3M", 80], ["PF-E22-90", 250], ["PF-T22", 60]] },
    { num: "DL-2026-7D02E5AA", po: "PO-77771", h: 140, ch: "WEB", by: buyer.id, status: "INVOICED", lines: [["FLX-SOL", 6], ["FLX-PST", 12]] },
  ];
  for (const o of history) {
    const lines = o.lines.map(([sku, qty]) => {
      const u = unit(sku, qty);
      return { productId: bySku.get(sku)!, qty, unitMinor: BigInt(u.p), lineMinor: BigInt(u.p * qty), priceSource: u.src };
    });
    const total = lines.reduce((s, l) => s + l.lineMinor, 0n);
    await prisma.order.create({
      data: {
        number: o.num,
        poNumber: o.po,
        tradeAccountId: account.id,
        status: o.status,
        channel: o.ch,
        placedById: o.by,
        subtotalMinor: total,
        totalMinor: total,
        submittedAt: hours(o.h),
        createdAt: hours(o.h),
        lines: { create: lines },
      },
    });
  }

  const quote = async (number: string, status: "REQUESTED" | "IN_REVIEW" | "OFFERED", items: Array<[string, number]>, validDays?: number) =>
    prisma.quote.create({
      data: {
        number,
        tradeAccountId: account.id,
        status,
        requestedById: owner.id,
        handledById: status === "REQUESTED" ? null : rep.id,
        validUntil: validDays ? days(validDays) : null,
        lines: { create: items.map(([sku, qty]) => ({ productId: bySku.get(sku)!, qty })) },
      },
    });
  await quote("QT-4410", "OFFERED", [["PEX-16-50", 120], ["PF-C15", 2000], ["PF-C22", 1500]], 5);
  await quote("QT-4417", "IN_REVIEW", [["EXP-18L", 30], ["EXP-24L", 30]]);
  await quote("QT-4421", "REQUESTED", [["BV-1028", 200]]);

  await prisma.ledgerEntry.createMany({
    data: [
      { tradeAccountId: account.id, kind: "INVOICE", reference: "INV-209102", amountMinor: 4_120_000n, postedAt: days(-75), dueAt: days(-45) },
      { tradeAccountId: account.id, kind: "INVOICE", reference: "INV-209511", amountMinor: 318_220n, postedAt: days(-33), dueAt: days(-3) },
      { tradeAccountId: account.id, kind: "PAYMENT", reference: "PAY-55102", amountMinor: -1_500_000n, postedAt: days(-2) },
      { tradeAccountId: account.id, kind: "CREDIT_NOTE", reference: "CN-01877", amountMinor: -12_640n, postedAt: days(-4) },
      { tradeAccountId: account.id, kind: "INVOICE", reference: "INV-209874", amountMinor: 41_760n, postedAt: days(-6), dueAt: days(24) },
      { tradeAccountId: account.id, kind: "INVOICE", reference: "INV-209931", amountMinor: 96_480n, postedAt: days(-1), dueAt: days(29) },
    ],
  });

  console.log(`
Seeded DROPLET dev data.
  Portal sign-in password (all users): ${DEMO_PASSWORD}
  priya@northgate.example  account owner, MFA on
  dan@northgate.example    buyer, no MFA yet (portal will ask to set it up before desktop download)
  Priya's authenticator secret: ${base32(totpSecret)}
    ${otpauthUri(owner.email, totpSecret)}
  Current code any time:  npm run totp -- priya@northgate.example
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
