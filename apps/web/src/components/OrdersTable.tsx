import { Monitor, RotateCcw, Globe, UserRound } from "lucide-react";
import { money, relative } from "../lib/format";
import type { OrderStatus, OrderSummary } from "../lib/types";

const statusMeta: Record<OrderStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Draft", cls: "bg-muted/10 text-muted" },
  PENDING_APPROVAL: { label: "Awaiting approval", cls: "bg-warn/15 text-warn" },
  SUBMITTED: { label: "Submitted", cls: "bg-accent/10 text-accent" },
  CONFIRMED: { label: "Confirmed", cls: "bg-accent/10 text-accent" },
  PART_SHIPPED: { label: "Part shipped", cls: "bg-ok/10 text-ok" },
  SHIPPED: { label: "Shipped", cls: "bg-ok/10 text-ok" },
  INVOICED: { label: "Invoiced", cls: "bg-muted/10 text-ink" },
  CANCELLED: { label: "Cancelled", cls: "bg-danger/10 text-danger" },
};

const channelIcon = { WEB: Globe, DESKTOP: Monitor, REP: UserRound } as const;
const channelLabel = { WEB: "Web portal", DESKTOP: "Desktop app", REP: "Placed by account manager" } as const;

export function OrdersTable({ orders, currency, onReorder }: { orders: OrderSummary[]; currency: string; onReorder: (o: OrderSummary) => void }) {
  return (
    <section id="orders" className="glass scroll-mt-4 p-5 sm:p-6" aria-labelledby="orders-title">
      <div className="flex items-center justify-between">
        <h2 id="orders-title" className="section-title">Recent orders</h2>
        <span className="text-xs text-muted">Last {orders.length}</span>
      </div>
      <div className="-mx-1 mt-3 overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="px-1 pb-2 font-medium">Order</th>
              <th className="px-1 pb-2 font-medium">Placed</th>
              <th className="px-1 pb-2 text-right font-medium">Lines</th>
              <th className="px-1 pb-2 text-right font-medium">Total</th>
              <th className="px-1 pb-2 font-medium">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-sm text-muted">No orders yet. Your first one starts in Quick order above.</td>
              </tr>
            )}
            {orders.map((o) => {
              const Ch = channelIcon[o.channel];
              const s = statusMeta[o.status];
              return (
                <tr key={o.number} className="group border-t border-line/60 dark:border-line/[0.07]">
                  <td className="px-1 py-3">
                    <div className="font-mono text-xs font-semibold">{o.number}</div>
                    <div className="text-xs text-muted">{o.poNumber ?? "No PO reference"}</div>
                  </td>
                  <td className="px-1 py-3">
                    <div className="flex items-center gap-1.5">
                      <Ch className="h-3.5 w-3.5 text-muted" aria-label={channelLabel[o.channel]} />
                      <span>{o.placedBy}</span>
                    </div>
                    <div className="text-xs text-muted">{relative(o.placedAt)}</div>
                  </td>
                  <td className="num px-1 py-3 text-right">{o.lines}</td>
                  <td className="num px-1 py-3 text-right font-semibold">{money(o.totalMinor, currency)}</td>
                  <td className="px-1 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
                  </td>
                  <td className="py-3 text-right">
                    <button onClick={() => onReorder(o)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent opacity-80 hover:bg-accent/10 group-hover:opacity-100">
                      <RotateCcw className="h-3.5 w-3.5" /> Reorder
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
