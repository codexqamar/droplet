import { Check, Monitor, RotateCcw, Globe, Truck, UserRound, X } from "lucide-react";
import { useState } from "react";
import { money, relative } from "../lib/format";
import type { OrderStatus, OrderSummary } from "../lib/types";

const statusMeta: Record<OrderStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Draft", cls: "bg-muted/10 text-muted" },
  AWAITING_BUYER_APPROVAL: { label: "Needs your team's approval", cls: "bg-warn/15 text-warn" },
  PENDING_APPROVAL: { label: "Awaiting approval", cls: "bg-warn/15 text-warn" },
  SUBMITTED: { label: "Submitted", cls: "bg-accent/10 text-accent" },
  CONFIRMED: { label: "Confirmed", cls: "bg-accent/10 text-accent" },
  PART_SHIPPED: { label: "Part shipped", cls: "bg-ok/10 text-ok" },
  SHIPPED: { label: "Shipped", cls: "bg-ok/10 text-ok" },
  INVOICED: { label: "Invoiced", cls: "bg-muted/10 text-ink" },
  CANCELLED: { label: "Cancelled", cls: "bg-danger/10 text-danger" },
};
const fallbackStatus = { label: "Updated", cls: "bg-muted/10 text-muted" };

const channelIcon = { WEB: Globe, DESKTOP: Monitor, REP: UserRound } as const;
const channelLabel = { WEB: "Web portal", DESKTOP: "Desktop app", REP: "Placed by account manager" } as const;

function Tracking({ t }: { t: NonNullable<OrderSummary["tracking"]> }) {
  const label = [t.carrier, t.number].filter(Boolean).join(" ");
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-muted">
      <Truck className="h-3 w-3 shrink-0" />
      {t.url ? (
        <a href={t.url} target="_blank" rel="noreferrer noopener" className="truncate font-medium text-accent hover:underline">{label || "Track delivery"}</a>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </div>
  );
}

export function OrdersTable({ orders, currency, onReorder, title = "Recent orders", onApprove }: {
  orders: OrderSummary[];
  currency: string;
  onReorder: (o: OrderSummary) => void;
  title?: string;
  /** Set for account owners/approvers: sign off colleagues' orders above their spend limit. */
  onApprove?: (number: string, action: "approve" | "reject") => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (number: string, action: "approve" | "reject") => {
    if (!onApprove) return;
    setBusy(number + action);
    try {
      await onApprove(number, action);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="orders" className="glass scroll-mt-4 p-4 sm:p-6" aria-labelledby="orders-title">
      <div className="flex items-center justify-between">
        <h2 id="orders-title" className="section-title">{title}</h2>
        <span className="text-xs text-muted">Last {orders.length}</span>
      </div>

      {/* Phones */}
      <ul className="mt-3 divide-y divide-line/60 sm:hidden dark:divide-line/[0.07]">
        {orders.length === 0 && <li className="py-8 text-center text-sm text-muted">No orders yet.</li>}
        {orders.map((o) => {
          const s = statusMeta[o.status] ?? fallbackStatus;
          return (
            <li key={o.number} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-semibold">{o.number}</div>
                  <div className="text-xs text-muted">{o.poNumber ?? "No PO"} · {o.placedBy} · {relative(o.placedAt)}</div>
                </div>
                <div className="num shrink-0 text-sm font-semibold">{money(o.totalMinor, currency)}</div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
                {o.status === "AWAITING_BUYER_APPROVAL" && onApprove ? (
                  <>
                    <button className="btn-primary min-h-8 px-3 py-1 text-xs" disabled={!!busy} onClick={() => void decide(o.number, "approve")}><Check className="h-3.5 w-3.5" /> Approve</button>
                    <button className="btn-ghost min-h-8 px-3 py-1 text-xs" disabled={!!busy} onClick={() => void decide(o.number, "reject")}>Reject</button>
                  </>
                ) : (
                  <button onClick={() => onReorder(o)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
                    <RotateCcw className="h-3.5 w-3.5" /> Reorder
                  </button>
                )}
              </div>
              {o.tracking && <Tracking t={o.tracking} />}
            </li>
          );
        })}
      </ul>

      <div className="-mx-1 mt-3 hidden overflow-x-auto sm:block">
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
                <td colSpan={6} className="py-8 text-center text-sm text-muted">No orders yet. Your first one starts in Quick order.</td>
              </tr>
            )}
            {orders.map((o) => {
              const Ch = channelIcon[o.channel];
              const s = statusMeta[o.status] ?? fallbackStatus;
              return (
                <tr key={o.number} className="group border-t border-line/60 align-top dark:border-line/[0.07]">
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
                    {o.tracking && <Tracking t={o.tracking} />}
                  </td>
                  <td className="py-3 text-right">
                    {o.status === "AWAITING_BUYER_APPROVAL" && onApprove ? (
                      <div className="flex justify-end gap-1.5">
                        <button className="btn-primary min-h-8 px-3 py-1 text-xs" disabled={!!busy} onClick={() => void decide(o.number, "approve")}>
                          <Check className="h-3.5 w-3.5" /> {busy === o.number + "approve" ? "Approving…" : "Approve"}
                        </button>
                        <button className="btn-ghost min-h-8 px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => void decide(o.number, "reject")} aria-label={`Reject ${o.number}`} title="Reject">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => onReorder(o)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-accent opacity-80 hover:bg-accent/10 group-hover:opacity-100">
                        <RotateCcw className="h-3.5 w-3.5" /> Reorder
                      </button>
                    )}
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
