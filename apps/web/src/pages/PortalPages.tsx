import { BookOpen, Boxes, CheckCircle2, CircleDollarSign, FileText, PackageCheck, Search, ShieldAlert, ShoppingCart } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { CreditPanel } from "../components/CreditPanel";
import { DesktopAccess } from "../components/DesktopAccess";
import { OrdersTable } from "../components/OrdersTable";
import { QuickOrder } from "../components/QuickOrder";
import { QuotesPanel } from "../components/QuotesPanel";
import { StatCard } from "../components/StatCard";
import { StatementPanel } from "../components/StatementPanel";
import { availability, BranchList } from "../components/Availability";
import { PayPanel } from "./TradeExtras";
import { daysUntil, money } from "../lib/format";
import type { Dashboard as Data, LineItem, OrderSummary } from "../lib/types";

export type OrderActions = {
  inject: { nonce: number; lines: LineItem[] } | null;
  skuRef: RefObject<HTMLInputElement>;
  onPlace: (lines: LineItem[], po: string | undefined, mode: "submit" | "draft") => Promise<string>;
  onQuote: (lines: LineItem[]) => Promise<string>;
  onReorder: (order: OrderSummary) => void;
  /** Web: save the current lines as a reusable list. */
  onSaveList?: (name: string, lines: LineItem[]) => Promise<string>;
  /** Web, approvers only: sign off a colleague's order above their spend limit. */
  onApprove?: (number: string, action: "approve" | "reject") => Promise<void>;
};

function PageHeading({ title, description, meta }: { title: string; description: string; meta?: string }) {
  return (
    <div className="portal-heading">
      <div className="min-w-0">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {meta && <span className="portal-heading__meta">{meta}</span>}
    </div>
  );
}

export function DashboardOverview({ data, desktopCtx, onReorder, onApprove }: { data: Data; desktopCtx?: { deviceId: string | null; version: string }; onReorder: (order: OrderSummary) => void; onApprove?: OrderActions["onApprove"] }) {
  const { account, credit, orders, quotes, ledger } = data;
  const available = Math.max(credit.limitMinor - credit.balanceMinor, 0);
  const openOrders = orders.filter((order) => !["INVOICED", "CANCELLED", "DRAFT"].includes(order.status));
  const awaiting = orders.filter((order) => order.status === "PENDING_APPROVAL").length;
  const needsMe = onApprove ? orders.filter((order) => order.status === "AWAITING_BUYER_APPROVAL").length : 0;
  const offered = quotes.filter((quote) => quote.status === "OFFERED").length;
  const overdue = credit.aging.slice(1).reduce((sum, item) => sum + item.amountMinor, 0);
  const nextDue = ledger
    .filter((line) => line.amountMinor > 0 && line.dueAt && daysUntil(line.dueAt) >= 0)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))[0];

  return (
    <>
      <PageHeading
        title="Trade dashboard"
        description={`Good to see you, ${account.user.name.split(" ")[0]}. Here is the current position for ${account.legalName}.`}
        meta={`Account ${account.code}`}
      />
      {needsMe > 0 && (
        <button className="glass mt-4 flex w-full items-center gap-3 px-4 py-3 text-left text-sm" onClick={() => document.getElementById("orders")?.scrollIntoView({ behavior: "smooth" })}>
          <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
          <span className="flex-1">{needsMe} order{needsMe === 1 ? "" : "s"} from your team {needsMe === 1 ? "needs" : "need"} your approval.</span>
          <span className="text-xs font-semibold text-accent">Review</span>
        </button>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={PackageCheck} label="Open orders" value={String(openOrders.length).padStart(2, "0")} foot={awaiting ? `${awaiting} awaiting approval` : "No approvals pending"} badge={awaiting ? "Action" : undefined} />
        <StatCard icon={FileText} label="Open quotes" value={String(quotes.length).padStart(2, "0")} foot={offered ? `${offered} ready to review` : "No offers waiting"} badge={offered ? "New" : undefined} />
        <StatCard icon={CircleDollarSign} label="Available credit" value={<span className="text-[22px]">{money(available, account.currency)}</span>} foot={credit.limitMinor > 0 ? `of ${money(credit.limitMinor, account.currency)} limit` : "No credit limit set: orders go for approval"} />
        <StatCard icon={ShoppingCart} label="Statement balance" value={<span className="text-[22px]">{money(credit.balanceMinor, account.currency)}</span>} foot={overdue > 0 ? <span className="font-medium text-danger">{money(overdue, account.currency)} overdue</span> : nextDue ? `Next due in ${daysUntil(nextDue.dueAt!)} days` : "Nothing due"} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8"><OrdersTable orders={[...orders.filter((o) => onApprove && o.status === "AWAITING_BUYER_APPROVAL"), ...orders.filter((o) => !(onApprove && o.status === "AWAITING_BUYER_APPROVAL"))].slice(0, 6)} currency={account.currency} onReorder={onReorder} onApprove={onApprove} /></div>
        <div className="xl:col-span-4"><CreditPanel credit={credit} currency={account.currency} /></div>
        <div className="xl:col-span-7"><StatementPanel ledger={ledger.slice(0, 5)} currency={account.currency} /></div>
        <div className="xl:col-span-5"><DesktopAccess devices={data.devices} thisDevice={desktopCtx ? { id: desktopCtx.deviceId, version: desktopCtx.version } : undefined} /></div>
      </div>
    </>
  );
}

export function QuickOrderPage({ data, actions, allowDraft }: { data: Data; actions: OrderActions; allowDraft: boolean }) {
  const available = Math.max(data.credit.limitMinor - data.credit.balanceMinor, 0);
  return (
    <>
      <PageHeading title="Quick order" description="Enter a SKU, set the quantity, and submit the order or request a quote." meta={`${data.catalogue.length} account-priced items`} />
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <QuickOrder
            ref={actions.skuRef}
            catalogue={data.catalogue}
            currency={data.account.currency}
            availableCreditMinor={available}
            inject={actions.inject}
            allowDraft={allowDraft}
            onPlace={actions.onPlace}
            onQuote={actions.onQuote}
            onSaveList={actions.onSaveList}
            poRequired={!!data.account.poRequired}
            spendLimitMinor={data.account.user.canApprove ? null : (data.account.user.spendLimitMinor ?? null)}
          />
        </div>
        <div className="xl:col-span-4"><CreditPanel credit={data.credit} currency={data.account.currency} /></div>
      </div>
    </>
  );
}

export function CataloguePage({ data, onOrder, updatedAt }: { data: Data; onOrder: (lines: LineItem[]) => void; updatedAt?: Date | null }) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return data.catalogue;
    return data.catalogue.filter((item) => item.sku.toLowerCase().includes(value) || item.name.toLowerCase().includes(value) || item.barcode === value);
  }, [data.catalogue, query]);

  return (
    <>
      <PageHeading title="Catalogue" description="Live stock and account pricing for items available to your trade account." meta={`${data.catalogue.length} items`} />
      <section className="glass mt-4 p-4 sm:p-6" aria-labelledby="catalogue-title">
        <div className="catalogue-toolbar">
          <div>
            <h2 id="catalogue-title" className="section-title">Account catalogue</h2>
            <p className="mt-1 text-xs text-muted">
              Prices exclude any taxes shown at checkout.{" "}
              {updatedAt && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" /> Live stock, updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
            </p>
          </div>
          <label className="catalogue-search">
            <Search className="h-4 w-4" />
            <span className="sr-only">Search catalogue</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search SKU or description" />
          </label>
        </div>
        {items.length === 0 ? (
          <div className="empty-state"><BookOpen /><h3>No matching items</h3><p>Try a different SKU or description.</p></div>
        ) : (
          <div className="catalogue-list mt-4">
            {items.map((item) => {
              const price = item.breaks[0]?.unitMinor ?? item.listMinor;
              const a = availability(item);
              return (
                <article key={item.sku} className="catalogue-row">
                  <div className="catalogue-row__identity">
                    <span className="catalogue-row__icon"><Boxes className="h-4 w-4" /></span>
                    <div className="min-w-0"><code>{item.sku}</code><h3>{item.name}</h3><p>{item.packSize} per {item.uom}</p></div>
                  </div>
                  <div className="min-w-0">
                    <span className="catalogue-row__label">Stock</span>
                    <strong className={a.tone === "ok" ? "text-ok" : a.tone === "warn" ? "text-warn" : "text-danger"}>{item.stock > 0 ? `${item.stock} available` : item.leadTimeDays ? `Ships in ~${item.leadTimeDays} days` : "Out of stock"}</strong>
                    <BranchList item={item} />
                  </div>
                  <div><span className="catalogue-row__label">Your price</span><strong>{money(price, data.account.currency)}</strong>{item.breaks.length > 1 && <small>{item.breaks.length - 1} volume break{item.breaks.length > 2 ? "s" : ""}</small>}</div>
                  <button className="btn-ghost catalogue-row__action" disabled={item.stock <= 0 && !item.leadTimeDays} onClick={() => onOrder([{ sku: item.sku, qty: 1 }])}><ShoppingCart className="h-4 w-4" /> {item.stock > 0 ? "Order" : "Backorder"}</button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export function OrdersPage({ data, onReorder, onApprove }: { data: Data; onReorder: (order: OrderSummary) => void; onApprove?: OrderActions["onApprove"] }) {
  const open = data.orders.filter((order) => !["INVOICED", "CANCELLED"].includes(order.status)).length;
  return <><PageHeading title="Orders" description="Track every web, desktop, and account-manager order in one place, with delivery tracking once shipped." meta={`${open} open`} /><div className="mt-4"><OrdersTable title="Orders" orders={data.orders} currency={data.account.currency} onReorder={onReorder} onApprove={onApprove} /></div></>;
}

export function QuotesPage({ data, onAccept }: { data: Data; onAccept?: (number: string) => Promise<string> }) {
  const offered = data.quotes.filter((quote) => quote.status === "OFFERED").length;
  return <><PageHeading title="Quotes" description="Review quote requests and offers being handled by your account team." meta={offered ? `${offered} ready` : "No offers waiting"} /><div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]"><QuotesPanel quotes={data.quotes} currency={data.account.currency} onAccept={onAccept} /><section className="glass p-5 sm:p-6"><CheckCircle2 className="h-5 w-5 text-ok" /><h2 className="section-title mt-4">What happens next</h2><p className="mt-2 max-w-[48ch] text-sm leading-6 text-muted">Your account manager reviews each request. When an offer is ready, its status changes here and the validity date is shown with it.</p></section></div></>;
}

export function StatementsPage({ data, onPaid }: { data: Data; onPaid?: () => Promise<void> }) {
  const canPay = !!data.payments?.enabled && !!onPaid;
  return (
    <>
      <PageHeading title="Statements" description={canPay ? "Credit position, payment terms and account activity. Pay invoices online by card or Direct Debit." : "Credit position, payment terms, and recent account activity."} meta={`${data.credit.termsDays}-day terms`} />
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-4">
          {canPay && <PayPanel data={data} onPaid={onPaid!} />}
          <CreditPanel credit={data.credit} currency={data.account.currency} />
        </div>
        <div className="xl:col-span-8"><StatementPanel ledger={data.ledger} currency={data.account.currency} /></div>
      </div>
    </>
  );
}
