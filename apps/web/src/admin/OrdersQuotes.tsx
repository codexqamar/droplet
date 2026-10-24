import { ChevronDown, FileText, Globe, Monitor, PackageCheck, Truck, UserRound } from "lucide-react";
import { useState } from "react";
import { admin, parseMoney, toMoneyInput, type AdminOrder, type AdminQuote, type OrderStatus } from "../lib/admin";
import { money, relative, shortDate } from "../lib/format";
import { Badge, EmptyState, ErrorText, Field, inputCls, Modal, PageHeading, Panel, SearchBox, Segmented, useAction, useLoad } from "./ui";

/** Common UK carriers with their public tracking page; the tracking number is appended. */
const carriers: Array<[string, string]> = [
  ["DPD", "https://track.dpd.co.uk/parcels/"],
  ["Royal Mail", "https://www.royalmail.com/track-your-item#/tracking-results/"],
  ["DHL", "https://www.dhl.com/gb-en/home/tracking.html?tracking-id="],
  ["UPS", "https://www.ups.com/track?tracknum="],
  ["Parcelforce", "https://www.parcelforce.com/track-trace?trackNumber="],
  ["Evri", "https://www.evri.com/track/parcel/"],
  ["Own delivery", ""],
];

function ShipDialog({ order, status, onClose, onDone }: { order: AdminOrder; status: "SHIPPED" | "PART_SHIPPED"; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [carrier, setCarrier] = useState(order.tracking?.carrier ?? "DPD");
  const [number, setNumber] = useState(order.tracking?.number ?? "");
  const base = carriers.find(([c]) => c === carrier)?.[1] ?? "";
  const [url, setUrl] = useState(order.tracking?.url ?? "");
  const effectiveUrl = url || (base && number ? base + encodeURIComponent(number.trim()) : "");
  return (
    <Modal title={`${status === "SHIPPED" ? "Ship" : "Part ship"} ${order.number}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        void act.run("ship", () => admin.setOrderStatus(order.number, status, { carrier: carrier.trim() || undefined, trackingNumber: number.trim() || undefined, trackingUrl: effectiveUrl || undefined })).then((ok) => ok && (onDone(), onClose()));
      }}>
        <p className="text-sm text-muted">The customer is emailed with the tracking details, and they appear on the order in the trade portal.</p>
        <Field label="Carrier">
          <input className={inputCls} list="carriers" value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={60} />
          <datalist id="carriers">{carriers.map(([c]) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Tracking number (optional)"><input className={`${inputCls} font-mono`} value={number} onChange={(e) => setNumber(e.target.value)} maxLength={80} /></Field>
        <Field label="Tracking link" hint={base ? "Filled in from the carrier; override if needed." : "Optional."}>
          <input className={inputCls} type="url" value={url || effectiveUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={500} />
        </Field>
        <ErrorText error={act.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!act.busy}><Truck className="h-4 w-4" /> {act.busy ? "Saving…" : status === "SHIPPED" ? "Mark shipped" : "Mark part shipped"}</button>
        </div>
      </form>
    </Modal>
  );
}

const actionLabel: Partial<Record<OrderStatus, string>> = {
  SUBMITTED: "Approve",
  CONFIRMED: "Confirm",
  PART_SHIPPED: "Part shipped",
  SHIPPED: "Mark shipped",
  INVOICED: "Invoice",
  CANCELLED: "Cancel",
};
const channelIcon = { WEB: Globe, DESKTOP: Monitor, REP: UserRound } as const;

type OrderFilter = "PENDING_APPROVAL" | "SUBMITTED" | "CONFIRMED" | "SHIPPED" | "INVOICED" | "ALL";

export function OrdersPage() {
  const [filter, setFilter] = useState<OrderFilter>("PENDING_APPROVAL");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => admin.orders(filter, q.trim() || undefined), [filter, q]);
  const all = useLoad(() => admin.orders("ALL"), []);
  const act = useAction();
  const [shipping, setShipping] = useState<{ order: AdminOrder; status: "SHIPPED" | "PART_SHIPPED" } | null>(null);
  const count = (s: OrderStatus) => (all.data?.orders ?? []).filter((o) => o.status === s).length;

  return (
    <div className="space-y-5">
      <PageHeading title="Orders" description="Approve over-credit orders, confirm, ship with tracking and invoice. Invoicing posts the amount to the customer's statement." />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "PENDING_APPROVAL", label: "Needs approval", count: count("PENDING_APPROVAL") },
            { value: "SUBMITTED", label: "New", count: count("SUBMITTED") },
            { value: "CONFIRMED", label: "Confirmed" },
            { value: "SHIPPED", label: "Shipped" },
            { value: "INVOICED", label: "Invoiced" },
            { value: "ALL", label: "All" },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Order, PO or customer" />
      </div>
      <ErrorText error={act.error ?? list.error} />
      <Panel>
        {!list.loading && list.data?.orders.length === 0 && <EmptyState icon={PackageCheck} title="Nothing here" body="Orders in this state will appear here." />}
        <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
          {list.data?.orders.map((o) => {
            const Ch = channelIcon[o.channel];
            const expanded = open === o.number;
            return (
              <li key={o.number} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setOpen(expanded ? null : o.number)} aria-expanded={expanded}>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${expanded ? "rotate-180" : ""}`} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold">{o.number}</span>
                        <Badge status={o.status} />
                      </div>
                      <div className="truncate text-xs text-muted">
                        <span className="font-medium text-ink">{o.account.name}</span> · {o.poNumber ?? "no PO"} · <Ch className="inline h-3 w-3" aria-label={o.channel} /> {o.placedBy}, {relative(o.placedAt)}
                      </div>
                      {o.tracking && (
                        <div className="flex items-center gap-1 text-[11px] text-muted">
                          <Truck className="h-3 w-3" /> {[o.tracking.carrier, o.tracking.number].filter(Boolean).join(" ")}
                          {o.tracking.url && <a className="text-accent hover:underline" href={o.tracking.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>track</a>}
                        </div>
                      )}
                    </div>
                  </button>
                  <span className="num w-28 text-right font-semibold">{money(o.totalMinor, o.currency)}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {o.next.map((s) => (
                      <button key={s} disabled={!!act.busy}
                        className={s === "CANCELLED" ? "btn-ghost px-3 py-1.5 text-xs text-danger" : "btn-primary px-3 py-1.5 text-xs"}
                        onClick={() =>
                          s === "SHIPPED" || s === "PART_SHIPPED"
                            ? setShipping({ order: o, status: s })
                            : void act.run(`${o.number}:${s}`, () => admin.setOrderStatus(o.number, s)).then((ok) => ok && (list.reload(), all.reload()))
                        }>
                        {act.busy === `${o.number}:${s}` ? "…" : actionLabel[s]}
                      </button>
                    ))}
                  </div>
                </div>
                {expanded && (
                  <table className="ml-7 mt-3 w-[calc(100%-1.75rem)] text-sm">
                    <tbody>
                      {o.lines.map((l) => (
                        <tr key={l.sku} className="border-t border-line/40 dark:border-line/[0.06]">
                          <td className="py-2"><span className="font-mono text-xs font-semibold">{l.sku}</span> <span className="text-muted">{l.name}</span></td>
                          <td className="num py-2 text-right">{l.qty}</td>
                          <td className="num py-2 text-right text-muted">{money(l.unitMinor, o.currency)}</td>
                          <td className="py-2 text-right"><Badge label={l.source.toLowerCase()} tone="muted" /></td>
                          <td className="num py-2 text-right font-medium">{money(l.lineMinor, o.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>
      {shipping && <ShipDialog order={shipping.order} status={shipping.status} onClose={() => setShipping(null)} onDone={() => (list.reload(), all.reload())} />}
    </div>
  );
}

type QuoteFilter = "REQUESTED" | "IN_REVIEW" | "OFFERED" | "ACCEPTED" | "ALL";

export function QuotesPage() {
  const [filter, setFilter] = useState<QuoteFilter>("REQUESTED");
  const list = useLoad(() => admin.quotes(filter), [filter]);
  const all = useLoad(() => admin.quotes("ALL"), []);
  const count = (s: string) => (all.data?.quotes ?? []).filter((q) => q.status === s).length;
  const reload = () => {
    void list.reload();
    void all.reload();
  };

  return (
    <div className="space-y-5">
      <PageHeading title="Quotes" description="Price customer quote requests. Customers accept an offer from their portal and it becomes an order at the offered prices." />
      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: "REQUESTED", label: "New requests", count: count("REQUESTED") },
          { value: "IN_REVIEW", label: "In review", count: count("IN_REVIEW") },
          { value: "OFFERED", label: "Offer sent" },
          { value: "ACCEPTED", label: "Accepted" },
          { value: "ALL", label: "All" },
        ]}
      />
      {list.error && <ErrorText error={list.error} />}
      {!list.loading && list.data?.quotes.length === 0 && <Panel><EmptyState icon={FileText} title="No quotes here" body="Quote requests from customers will appear here." /></Panel>}
      <div className="grid gap-4 xl:grid-cols-2">
        {list.data?.quotes.map((q) => <QuoteCard key={q.number} quote={q} onChanged={reload} />)}
      </div>
    </div>
  );
}

function QuoteCard({ quote: q, onChanged }: { quote: AdminQuote; onChanged: () => void }) {
  const editable = ["REQUESTED", "IN_REVIEW", "OFFERED"].includes(q.status);
  const [prices, setPrices] = useState<Record<string, string>>(() => Object.fromEntries(q.lines.map((l) => [l.id, toMoneyInput(l.offeredMinor ?? l.listMinor)])));
  const [days, setDays] = useState("14");
  const act = useAction();
  const total = q.lines.reduce((s, l) => s + (parseMoney(prices[l.id] ?? "") ?? 0) * l.qty, 0);

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold">{q.number}</span><Badge status={q.status} /></div>
          <div className="text-xs text-muted">{q.account.name} · {q.requestedBy} · {shortDate(q.createdAt)}{q.validUntil ? ` · valid until ${shortDate(q.validUntil)}` : ""}</div>
        </div>
        <span className="num text-lg font-semibold">{money(total, q.currency)}</span>
      </div>
      {q.notes && <p className="mt-2 rounded-xl bg-surface/50 px-3 py-2 text-xs">“{q.notes}”</p>}
      <table className="mt-3 w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted"><th className="pb-1 font-medium">Item</th><th className="pb-1 text-right font-medium">Qty</th><th className="pb-1 text-right font-medium">List</th><th className="pb-1 text-right font-medium">Offer / unit</th></tr></thead>
        <tbody>
          {q.lines.map((l) => (
            <tr key={l.id} className="border-t border-line/50 dark:border-line/[0.06]">
              <td className="py-2"><div className="font-mono text-xs font-semibold">{l.sku}</div><div className="max-w-[16rem] truncate text-xs text-muted">{l.name}</div></td>
              <td className="num py-2 text-right">{l.qty}</td>
              <td className="num py-2 text-right text-muted">{money(l.listMinor, q.currency)}</td>
              <td className="py-2 text-right">
                {editable ? (
                  <input className={`${inputCls} num ml-auto h-9 w-28 text-right`} inputMode="decimal" value={prices[l.id] ?? ""} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} aria-label={`Offer price for ${l.sku}`} />
                ) : (
                  <span className="num font-medium">{l.offeredMinor === null ? "—" : money(l.offeredMinor, q.currency)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorText error={act.error} />
      {editable && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <label className="mr-auto flex items-center gap-2 text-xs text-muted">
            Valid for <input className={`${inputCls} num h-9 w-16 text-center`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} aria-label="Valid for days" /> days
          </label>
          <button className="btn-ghost px-3 py-2 text-xs text-danger" disabled={!!act.busy} onClick={() => void act.run("decline", () => admin.quoteAction(q.number, "decline")).then((ok) => ok && onChanged())}>Decline</button>
          {q.status === "REQUESTED" && <button className="btn-ghost px-3 py-2 text-xs" disabled={!!act.busy} onClick={() => void act.run("review", () => admin.quoteAction(q.number, "review")).then((ok) => ok && onChanged())}>Start review</button>}
          <button className="btn-primary px-3 py-2 text-xs" disabled={!!act.busy} onClick={() => {
            const lines = q.lines.map((l) => ({ id: l.id, offeredMinor: parseMoney(prices[l.id] ?? "") }));
            if (lines.some((l) => l.offeredMinor === null)) return act.setError("Enter a price for every line.");
            void act.run("offer", () => admin.offerQuote(q.number, Number(days || 14), lines as Array<{ id: string; offeredMinor: number }>)).then((ok) => ok && onChanged());
          }}>{act.busy === "offer" ? "Sending…" : q.status === "OFFERED" ? "Update offer" : "Send offer"}</button>
        </div>
      )}
    </Panel>
  );
}
