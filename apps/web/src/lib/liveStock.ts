import { useEffect, useMemo, useState } from "react";
import { isDesktop, trade } from "./api";
import type { CatalogueItem } from "./types";

type StockRow = Pick<CatalogueItem, "stock" | "leadTimeDays" | "branches">;

/**
 * Keeps catalogue availability current on the web portal: polls the light /v1/portal/stock
 * endpoint while the tab is visible and overlays the result on the dashboard catalogue. The
 * desktop app shows its last synced snapshot instead (it may be offline).
 */
export function useLiveStock(catalogue: CatalogueItem[], intervalMs = 15_000): { catalogue: CatalogueItem[]; updatedAt: Date | null } {
  const [live, setLive] = useState<Map<string, StockRow> | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (isDesktop) return;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await trade.stock();
        if (stopped) return;
        setLive(new Map(r.items.map((i) => [i.sku, { stock: i.stock, leadTimeDays: i.leadTimeDays, branches: i.branches }])));
        setUpdatedAt(new Date(r.at));
      } catch {
        /* keep the last known figures; the next tick retries */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  const merged = useMemo(() => (live ? catalogue.map((c) => ({ ...c, ...(live.get(c.sku) ?? {}) })) : catalogue), [catalogue, live]);
  return { catalogue: merged, updatedAt };
}
