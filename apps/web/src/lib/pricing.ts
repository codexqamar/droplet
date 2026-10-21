import type { CatalogueItem, PriceSource } from "./types";

/**
 * Display-only price resolution (best qty break). The server re-resolves on submit;
 * this exists so the quick-order grid updates instantly while typing.
 */
export function unitPrice(item: CatalogueItem, qty: number): { unitMinor: number; source: PriceSource } {
  let best: { unitMinor: number; source: PriceSource } = { unitMinor: item.listMinor, source: "LIST" };
  for (const b of item.breaks) if (qty >= b.minQty) best = { unitMinor: b.unitMinor, source: b.source };
  return best;
}

/** Next quantity break the buyer could reach, for "buy N more to save" hints. */
export function nextBreak(item: CatalogueItem, qty: number) {
  return item.breaks.find((b) => b.minQty > qty) ?? null;
}
