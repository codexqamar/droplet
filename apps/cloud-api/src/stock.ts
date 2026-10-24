import type { Tx } from "./db.js";

/**
 * Catalogue write helpers shared by the admin portal, CSV import and the integration API.
 * Stock lives per warehouse (StockLevel); Product.stockQty is the total, kept in step here so
 * the desktop sync and older read paths keep working unchanged.
 */

/** Global monotonic version used by desktop delta sync. */
export async function nextSyncVersion(tx: Tx): Promise<bigint> {
  const row = await tx.syncSequence.upsert({ where: { id: 1 }, create: { id: 1, value: 1n }, update: { value: { increment: 1n } } });
  return row.value;
}

export async function bumpProducts(tx: Tx, productIds: string[]): Promise<void> {
  for (const id of productIds) await tx.product.update({ where: { id }, data: { syncVersion: await nextSyncVersion(tx) } });
}

export async function defaultWarehouse(tx: Tx) {
  return (
    (await tx.warehouse.findFirst({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })) ??
    tx.warehouse.create({ data: { code: "MAIN", name: "Main warehouse" } })
  );
}

/** Sets stock at one or more warehouses and recomputes the product total. */
export async function setStock(tx: Tx, productId: string, levels: Array<{ warehouseId: string; qty: number }>): Promise<number> {
  for (const l of levels) {
    await tx.stockLevel.upsert({
      where: { warehouseId_productId: { warehouseId: l.warehouseId, productId } },
      create: { warehouseId: l.warehouseId, productId, qty: Math.max(0, l.qty) },
      update: { qty: Math.max(0, l.qty) },
    });
  }
  const total = (await tx.stockLevel.aggregate({ where: { productId, warehouse: { active: true } }, _sum: { qty: true } }))._sum.qty ?? 0;
  await tx.product.update({ where: { id: productId }, data: { stockQty: total, syncVersion: await nextSyncVersion(tx) } });
  return total;
}

/** Resolves warehouse codes (case-insensitive) to ids; unknown codes are returned separately. */
export async function warehousesByCode(tx: Tx): Promise<Map<string, string>> {
  const all = await tx.warehouse.findMany();
  return new Map(all.map((w) => [w.code.toUpperCase(), w.id]));
}
