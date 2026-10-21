import type { Tx } from "./db.js";

export type PriceSource = "ACCOUNT" | "TIER" | "LIST";

/**
 * Resolution order: negotiated account price (best qty break in validity window)
 * → account tier price → list price. Server-side only; client prices are display hints.
 */
export async function resolveUnitPrice(
  tx: Tx,
  tradeAccountId: string,
  productId: string,
  qty: number,
  at = new Date(),
): Promise<{ unitMinor: bigint; source: PriceSource }> {
  const contract = await tx.accountPrice.findFirst({
    where: {
      tradeAccountId,
      productId,
      minQty: { lte: qty },
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    },
    orderBy: [{ minQty: "desc" }, { validFrom: "desc" }],
  });
  if (contract) return { unitMinor: contract.unitMinor, source: "ACCOUNT" };

  const account = await tx.tradeAccount.findUniqueOrThrow({ where: { id: tradeAccountId }, select: { priceTierId: true } });
  if (account.priceTierId) {
    const tier = await tx.tierPrice.findFirst({
      where: { tierId: account.priceTierId, productId, minQty: { lte: qty } },
      orderBy: { minQty: "desc" },
    });
    if (tier) return { unitMinor: tier.unitMinor, source: "TIER" };
  }

  const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { listMinor: true } });
  return { unitMinor: product.listMinor, source: "LIST" };
}

/** Open statement balance (positive = owed). */
export async function openBalanceMinor(tx: Tx, tradeAccountId: string): Promise<bigint> {
  const agg = await tx.ledgerEntry.aggregate({ where: { tradeAccountId }, _sum: { amountMinor: true } });
  return agg._sum.amountMinor ?? 0n;
}
