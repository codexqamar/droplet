import type { CatalogueItem } from "../lib/types";

/**
 * Stock state for one item at a requested quantity, with lead time when it has to be ordered in
 * and per-branch availability. Branch detail is in the tooltip on compact rows and listed in full
 * where there is room.
 */
export function availability(item: Pick<CatalogueItem, "stock" | "leadTimeDays">, qty = 1): { tone: "ok" | "warn" | "danger"; text: string } {
  const lead = item.leadTimeDays ? ` · ${item.leadTimeDays}-day lead time` : "";
  if (item.stock <= 0) return { tone: "danger", text: item.leadTimeDays ? `Backorder · ships in ~${item.leadTimeDays} days` : "Backorder" };
  if (item.stock < qty) return { tone: "warn", text: `${item.stock} available${lead}` };
  if (item.stock < 100) return { tone: "warn", text: `${item.stock} in stock` };
  return { tone: "ok", text: "In stock" };
}

const dot = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" } as const;

export function StockDot({ item, qty = 1 }: { item: Pick<CatalogueItem, "stock" | "leadTimeDays" | "branches">; qty?: number }) {
  const a = availability(item, qty);
  const branches = item.branches?.length ? item.branches.map((b) => `${b.name}: ${b.qty}`).join("\n") : undefined;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted" title={branches}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[a.tone]}`} />
      {a.text}
    </span>
  );
}

export function BranchList({ item }: { item: Pick<CatalogueItem, "branches"> }) {
  if (!item.branches?.length) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1">
      {item.branches.map((b) => (
        <li key={b.code} className={`rounded-md px-1.5 py-px text-[10px] font-medium ${b.qty > 0 ? "bg-ok/10 text-ok" : "bg-muted/10 text-muted"}`} title={b.name}>
          {b.code} {b.qty > 0 ? b.qty : "–"}
        </li>
      ))}
    </ul>
  );
}
