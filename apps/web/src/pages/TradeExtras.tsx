import { BookmarkCheck, Building2, Check, CreditCard, Landmark, ListChecks, Lock, Pencil, ShoppingCart, Trash2, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError, trade } from "../lib/api";
import { money, relative, shortDate } from "../lib/format";
import { navigate } from "../lib/nav";
import type { Dashboard as Data, LineItem, OrderList, TeamMember } from "../lib/types";

/** Trade-portal pages that only exist on the web (they need the cloud, not the offline engine). */

function Heading({ title, description, meta }: { title: string; description: string; meta?: string }) {
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

const errText = (e: unknown) => (e as ApiError).message || "Something went wrong.";

function useList<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

// ───────────── saved order lists ─────────────

export function ListsPage({ data, onOrder }: { data: Data; onOrder: (lines: LineItem[]) => void }) {
  const lists = useList(() => trade.lists());
  const [editing, setEditing] = useState<OrderList | null>(null);
  const priceOf = (sku: string, qty: number) => {
    const item = data.catalogue.find((c) => c.sku === sku);
    if (!item) return 0;
    const brk = [...item.breaks].reverse().find((b) => qty >= b.minQty);
    return (brk?.unitMinor ?? item.listMinor) * qty;
  };

  return (
    <>
      <Heading title="Saved lists" description="Reusable order lists for each job, site or van. Add a whole list to an order in one tap, then adjust quantities." meta={lists.data ? `${lists.data.lists.length} lists` : undefined} />
      {lists.error && <p className="mt-4 text-sm text-danger">{lists.error}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {lists.data?.lists.length === 0 && (
          <section className="glass p-6 lg:col-span-2">
            <div className="empty-state">
              <ListChecks />
              <h3>No saved lists yet</h3>
              <p>Build an order in Quick order, then choose “Save as list”.</p>
            </div>
          </section>
        )}
        {lists.data?.lists.map((l) => {
          const total = l.items.reduce((s, i) => s + priceOf(i.sku, i.qty), 0);
          return (
            <section key={l.id} className="glass flex flex-col p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{l.name}</h2>
                  <p className="text-xs text-muted">
                    {l.items.length} item{l.items.length === 1 ? "" : "s"} · by {l.createdBy}
                    {l.lastUsedAt ? ` · used ${relative(l.lastUsedAt)}` : ""}
                  </p>
                  {l.note && <p className="mt-1 text-xs text-muted">{l.note}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink" aria-label={`Edit ${l.name}`} title="Edit" onClick={() => setEditing(l)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                    aria-label={`Delete ${l.name}`}
                    title="Delete"
                    onClick={async () => {
                      if (!window.confirm(`Delete the list “${l.name}”?`)) return;
                      await trade.deleteList(l.id);
                      await lists.reload();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <ul className="mt-3 flex-1 divide-y divide-line/50 text-sm dark:divide-line/[0.07]">
                {l.items.slice(0, 6).map((i) => (
                  <li key={i.sku} className="flex items-center gap-3 py-1.5">
                    <span className="w-24 shrink-0 font-mono text-[11px] font-semibold">{i.sku}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{i.name}</span>
                    <span className="num shrink-0 text-[13px] font-medium">× {i.qty}</span>
                  </li>
                ))}
                {l.items.length > 6 && <li className="py-1.5 text-xs text-muted">and {l.items.length - 6} more</li>}
              </ul>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/60 pt-3 dark:border-line/[0.07]">
                <div>
                  <div className="label">At your prices</div>
                  <div className="num font-semibold">{money(total, data.account.currency)}</div>
                </div>
                <button
                  className="btn-primary"
                  onClick={() => {
                    void trade.listUsed(l.id);
                    onOrder(l.items.map((i) => ({ sku: i.sku, qty: i.qty })));
                  }}
                >
                  <ShoppingCart className="h-4 w-4" /> Add to order
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {editing && <EditList list={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await lists.reload(); }} />}
    </>
  );
}

function EditList({ list, onClose, onSaved }: { list: OrderList; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(list.name);
  const [note, setNote] = useState(list.note ?? "");
  const [items, setItems] = useState(list.items);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!items.length) return setError("A list needs at least one item.");
    setBusy(true);
    try {
      await trade.updateList(list.id, name.trim(), items.map((i) => ({ sku: i.sku, qty: i.qty })), note.trim() || null);
      await onSaved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/25 p-4" role="dialog" aria-modal="true" aria-label="Edit list" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={save} className="glass-float my-8 w-full max-w-lg space-y-3 p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Edit list</h2>
        <label className="block"><span className="label">Name</span><input className="field mt-1 h-10 w-full px-3 text-sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
        <label className="block"><span className="label">Note</span><input className="field mt-1 h-10 w-full px-3 text-sm" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Optional" /></label>
        <ul className="max-h-72 divide-y divide-line/50 overflow-y-auto dark:divide-line/[0.07]">
          {items.map((i) => (
            <li key={i.sku} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1"><span className="block font-mono text-[11px] font-semibold">{i.sku}</span><span className="block truncate text-xs text-muted">{i.name}</span></span>
              <input className="field num h-9 w-20 px-2 text-right text-sm" inputMode="numeric" value={i.qty} aria-label={`Quantity for ${i.sku}`}
                onChange={(e) => setItems((p) => p.map((x) => (x.sku === i.sku ? { ...x, qty: Math.max(1, Number.parseInt(e.target.value.replace(/\D/g, "") || "1", 10)) } : x)))} />
              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Remove ${i.sku}`} onClick={() => setItems((p) => p.filter((x) => x.sku !== i.sku))}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save list"}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// ───────────── team (multi-user trade accounts) ─────────────

export function TeamPage({ data }: { data: Data }) {
  const team = useList(() => trade.team());
  const isOwner = !!data.account.user.owner;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = data.account.currency;

  const update = async (m: TeamMember, body: Parameters<typeof trade.updateMember>[1]) => {
    setError(null);
    try {
      await trade.updateMember(m.id, body);
      await team.reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <>
      <Heading title="Team" description="Colleagues who order on this trade account. Set who can approve orders and each buyer's spending limit; orders above a buyer's limit wait for an approver." meta={team.data ? `${team.data.users.length} people` : undefined} />
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="glass p-4 sm:p-6 xl:col-span-8">
          <h2 className="section-title flex items-center gap-2"><Users className="h-4 w-4 text-accent" /> People</h2>
          {(team.error || error) && <p className="mt-2 text-xs font-medium text-danger">{team.error ?? error}</p>}
          <ul className="mt-3 divide-y divide-line/60 dark:divide-line/[0.07]">
            {team.data?.users.map((m) => (
              <li key={m.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {m.name}
                    {m.owner && <span className="rounded-full bg-accent/10 px-2 py-px text-[10px] font-semibold text-accent">Owner</span>}
                    {!m.owner && m.canApprove && <span className="rounded-full bg-ok/10 px-2 py-px text-[10px] font-semibold text-ok">Approver</span>}
                    {!m.active && <span className="rounded-full bg-danger/10 px-2 py-px text-[10px] font-semibold text-danger">Deactivated</span>}
                  </div>
                  <div className="truncate text-xs text-muted">{m.email} · {m.lastLoginAt ? `last signed in ${relative(m.lastLoginAt)}` : "never signed in"}</div>
                </div>
                {m.owner ? (
                  <span className="text-xs text-muted">Approves all orders</span>
                ) : isOwner ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={m.canApprove} onChange={(e) => void update(m, { canApprove: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                      Approver
                    </label>
                    <SpendLimit value={m.spendLimitMinor} currency={cur} disabled={m.canApprove} onSave={(v) => update(m, { spendLimitMinor: v })} />
                    <button className="btn-ghost min-h-8 px-2.5 py-1 text-xs" onClick={() => void update(m, { active: !m.active })}>{m.active ? "Deactivate" : "Reactivate"}</button>
                  </div>
                ) : (
                  <span className="text-xs text-muted">{m.canApprove ? "Can approve orders" : m.spendLimitMinor !== null ? `Limit ${money(m.spendLimitMinor, cur)} per order` : "No spending limit"}</span>
                )}
              </li>
            ))}
            {team.data?.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <span className="text-xs text-muted">Invited · expires {shortDate(i.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="glass p-4 sm:p-6 xl:col-span-4">
          <h2 className="section-title flex items-center gap-2"><UserPlus className="h-4 w-4 text-accent" /> Invite a colleague</h2>
          {isOwner ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  const r = await trade.inviteColleague(email.trim(), name.trim() || undefined);
                  setInvite(r.inviteUrl);
                  setEmail("");
                  setName("");
                  await team.reload();
                } catch (err) {
                  setError((err as ApiError).code === "EMAIL_IN_USE" ? "That email already has an account." : errText(err));
                }
              }}
            >
              <input className="field h-10 w-full px-3 text-sm" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              <input className="field h-10 w-full px-3 text-sm" placeholder="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn-primary w-full" disabled={!email.trim()}>Send invite</button>
              {invite && (
                <p className="rounded-xl border border-ok/30 bg-ok/10 p-3 text-xs">
                  Invite sent. You can also share this link: <span className="break-all font-mono">{invite}</span>
                </p>
              )}
            </form>
          ) : (
            <p className="mt-2 text-sm text-muted">Ask your account owner to invite colleagues.</p>
          )}
        </section>
      </div>
    </>
  );
}

function SpendLimit({ value, currency, disabled, onSave }: { value: number | null; currency: string; disabled?: boolean; onSave: (v: number | null) => Promise<void> }) {
  const [text, setText] = useState(value === null ? "" : (value / 100).toFixed(0));
  useEffect(() => setText(value === null ? "" : (value / 100).toFixed(0)), [value]);
  const commit = () => {
    const t = text.replace(/[^\d.]/g, "");
    const next = t ? Math.round(Number(t) * 100) : null;
    if (next !== value) void onSave(next);
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted" title={disabled ? "Approvers have no spending limit" : "Leave blank for no limit"}>
      Limit
      <input
        className="field num h-8 w-24 px-2 text-right text-xs disabled:opacity-50"
        inputMode="decimal"
        placeholder="None"
        value={disabled ? "" : text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label={`Spending limit in ${currency}`}
      />
    </label>
  );
}

// ───────────── online payments ─────────────

export function PayPanel({ data, onPaid }: { data: Data; onPaid: () => Promise<void> }) {
  const pay = data.payments;
  const cur = data.account.currency;
  const balance = data.credit.balanceMinor;
  const overdue = data.credit.aging.slice(1).reduce((s, a) => s + a.amountMinor, 0);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // Returning from checkout: confirm the outcome with the server, then refresh the statement.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("payment");
    if (!id) return;
    navigate("/app/statements", true);
    if (params.get("cancelled")) {
      setNotice({ tone: "warn", text: "Payment cancelled. Nothing was charged." });
      return;
    }
    let tries = 0;
    const check = async () => {
      try {
        const p = await trade.payment(id);
        if (p.status === "SUCCEEDED") {
          setNotice({ tone: "ok", text: `Payment of ${money(p.amountMinor, p.currency)} received. Your statement is updated.` });
          await onPaid();
        } else if (p.status === "PENDING" && tries++ < 8) {
          setNotice({ tone: "warn", text: p.method === "bacs_debit" ? "Direct Debit set up. The payment shows once it clears (usually 3 working days)." : "Confirming your payment…" });
          if (p.method !== "bacs_debit") window.setTimeout(() => void check(), 2500);
        } else if (p.status !== "PENDING") setNotice({ tone: "warn", text: "The payment did not go through. Nothing was charged." });
      } catch {
        /* leave the statement as is */
      }
    };
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pay?.enabled) return null;
  const start = async (amountMinor: number, reference: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await trade.startPayment(amountMinor, reference);
      window.location.assign(r.url);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const customMinor = Math.round(Number(custom.replace(/[^\d.]/g, "") || "0") * 100);

  return (
    <section className="glass p-4 sm:p-6" aria-labelledby="pay-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pay-title" className="section-title flex items-center gap-2"><CreditCard className="h-4 w-4 text-accent" /> Pay online</h2>
        <span className="flex items-center gap-1 text-[11px] text-muted"><Lock className="h-3 w-3" /> {pay.provider === "stripe" ? "Secured by Stripe" : "Demo checkout"}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Card{pay.methods.includes("bacs_debit") ? " or Direct Debit" : ""}. Payments post to your statement straight away and free up credit.
      </p>
      {notice && <p className={`mt-3 rounded-xl px-3 py-2 text-xs font-medium ${notice.tone === "ok" ? "bg-ok/10 text-ok" : "bg-warn/15 text-warn"}`}>{notice.text}</p>}
      {balance <= 0 ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-ok"><Check className="h-4 w-4" /> Nothing to pay. Your account is up to date.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {overdue > 0 && overdue < balance && (
            <button className="btn-primary w-full justify-between" disabled={busy} onClick={() => void start(overdue, "Overdue invoices")}>
              <span>Pay overdue</span>
              <span className="num">{money(overdue, cur)}</span>
            </button>
          )}
          <button className={`${overdue > 0 && overdue < balance ? "btn-ghost" : "btn-primary"} w-full justify-between`} disabled={busy} onClick={() => void start(balance, "Statement balance")}>
            <span>Pay full balance</span>
            <span className="num">{money(balance, cur)}</span>
          </button>
          <div className="flex gap-2">
            <input className="field num h-11 min-w-0 flex-1 px-3 text-sm" inputMode="decimal" placeholder="Other amount" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Other amount" />
            <button className="btn-ghost" disabled={busy || customMinor < 100 || customMinor > balance} onClick={() => void start(customMinor, "Part payment")}>Pay</button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs font-medium text-danger">{error}</p>}
      {pay.recent.length > 0 && (
        <ul className="mt-4 divide-y divide-line/60 border-t border-line/60 text-xs dark:divide-line/[0.07] dark:border-line/[0.07]">
          {pay.recent.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              {p.method === "bacs_debit" ? <Landmark className="h-3.5 w-3.5 text-muted" /> : <CreditCard className="h-3.5 w-3.5 text-muted" />}
              <span className="min-w-0 flex-1 truncate">{p.reference} · {shortDate(p.at)}</span>
              <span className={p.status === "SUCCEEDED" ? "text-ok" : "text-warn"}>{p.status === "SUCCEEDED" ? "Paid" : "Processing"}</span>
              <span className="num font-semibold">{money(p.amountMinor, cur)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Simulated checkout for demo installs (PAYMENTS_DEMO / DROPLET_DEMO). No money moves. */
export function DemoCheckout({ id, business }: { id: string; business: string }) {
  const [p, setP] = useState<Awaited<ReturnType<typeof trade.payment>> | null>(null);
  const [method, setMethod] = useState<"card" | "bacs_debit">("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    trade.payment(id).then(setP, (e) => setError(errText(e)));
  }, [id]);
  const finish = async (cancel = false) => {
    setBusy(true);
    try {
      await trade.demoComplete(id, method, cancel);
      navigate(`/app/statements?payment=${id}${cancel ? "&cancelled=1" : ""}`);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="glass-strong w-full max-w-md p-6">
        <div className="rounded-xl bg-warn/15 px-3 py-2 text-xs font-semibold text-warn">Demo checkout: no card is charged and no money moves.</div>
        <div className="mt-5 flex items-center gap-2 text-sm text-muted"><Building2 className="h-4 w-4" /> Paying as {business}</div>
        <div className="num mt-1 text-3xl font-semibold tracking-tight">{p ? money(p.amountMinor, p.currency) : "…"}</div>
        <div className="text-sm text-muted">{p?.reference}</div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          {(["card", "bacs_debit"] as const).map((m) => (
            <button key={m} onClick={() => setMethod(m)} className={`rounded-xl border px-3 py-3 text-left text-sm ${method === m ? "border-accent bg-accent/10" : "border-line/70 dark:border-line/[0.1]"}`}>
              {m === "card" ? <CreditCard className="mb-1 h-4 w-4" /> : <Landmark className="mb-1 h-4 w-4" />}
              {m === "card" ? "Card" : "Direct Debit"}
            </button>
          ))}
        </div>
        {method === "card" ? (
          <div className="mt-4 space-y-2">
            <input className="field h-11 w-full px-3 font-mono text-sm" value="4242 4242 4242 4242" readOnly aria-label="Demo card number" />
            <div className="grid grid-cols-2 gap-2">
              <input className="field h-11 px-3 font-mono text-sm" value="12 / 30" readOnly aria-label="Demo expiry" />
              <input className="field h-11 px-3 font-mono text-sm" value="123" readOnly aria-label="Demo CVC" />
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <input className="field h-11 w-full px-3 font-mono text-sm" value="10-88-00" readOnly aria-label="Demo sort code" />
            <input className="field h-11 w-full px-3 font-mono text-sm" value="00012345" readOnly aria-label="Demo account number" />
          </div>
        )}
        {error && <p className="mt-3 text-xs font-medium text-danger">{error}</p>}
        <button className="btn-primary mt-5 w-full" disabled={busy || !p || p.status !== "PENDING"} onClick={() => void finish()}>
          <BookmarkCheck className="h-4 w-4" /> {busy ? "Processing…" : `Pay ${p ? money(p.amountMinor, p.currency) : ""}`}
        </button>
        <button className="mt-2 w-full text-xs text-muted hover:text-ink" disabled={busy} onClick={() => void finish(true)}>Cancel and return</button>
      </div>
    </div>
  );
}
