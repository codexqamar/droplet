import { Building2, Plus, ShieldOff, Trash2, UserPlus } from "lucide-react";
import { useRef, useState } from "react";
import { QuickOrder } from "../components/QuickOrder";
import { admin, parseMoney, toMoneyInput, type AccountRow, type Terms, type Tier } from "../lib/admin";
import { money, relative, shortDate } from "../lib/format";
import { Badge, CopyLink, EmptyState, ErrorText, Field, inputCls, Modal, PageHeading, Panel, SearchBox, Segmented, useAction, useLoad } from "./ui";

type Filter = "PENDING_APPROVAL" | "APPROVED" | "SUSPENDED" | "REJECTED" | "ALL";

export function AccountsPage({ isAdmin, focusId }: { isAdmin: boolean; focusId?: string | null }) {
  const [filter, setFilter] = useState<Filter>(isAdmin ? "PENDING_APPROVAL" : "APPROVED");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(focusId ?? null);
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => admin.accounts(filter, q.trim() || undefined), [filter, q]);
  const all = useLoad(() => admin.accounts("ALL"), []);
  const count = (s: Filter) => (all.data?.accounts ?? []).filter((a) => s === "ALL" || a.status === s).length;

  return (
    <div className="space-y-5">
      <PageHeading
        title="Trade accounts"
        description="Review applications, set credit terms and pricing, and manage everyone who orders on each account."
        action={isAdmin && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Open account</button>}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "PENDING_APPROVAL", label: "Applications", count: count("PENDING_APPROVAL") },
            { value: "APPROVED", label: "Active" },
            { value: "SUSPENDED", label: "Suspended" },
            { value: "REJECTED", label: "Rejected" },
            { value: "ALL", label: "All" },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Search name, code or email" />
      </div>

      <Panel>
        {list.error && <ErrorText error={list.error} />}
        {!list.loading && list.data?.accounts.length === 0 && (
          <EmptyState icon={Building2} title={filter === "PENDING_APPROVAL" ? "No applications waiting" : "No accounts here yet"} body={filter === "PENDING_APPROVAL" ? "New applications from the portal's Apply page appear here." : "Approved accounts will be listed here."} />
        )}
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            {!!list.data?.accounts.length && (
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-1 pb-2 font-medium">Account</th>
                  <th className="px-1 pb-2 font-medium">Contact</th>
                  <th className="px-1 pb-2 font-medium">Status</th>
                  <th className="px-1 pb-2 text-right font-medium">Balance / limit</th>
                  <th className="px-1 pb-2 font-medium">Manager</th>
                  <th className="px-1 pb-2 font-medium">Since</th>
                </tr>
              </thead>
            )}
            <tbody>
              {list.data?.accounts.map((a) => (
                <tr key={a.id} onClick={() => setOpen(a.id)} className="cursor-pointer border-t border-line/60 transition hover:bg-surface/40 dark:border-line/[0.07]">
                  <td className="px-1 py-3">
                    <div className="font-semibold">{a.legalName}</div>
                    <div className="font-mono text-[11px] text-muted">{a.code}{a.tier ? ` · ${a.tier}` : ""}</div>
                  </td>
                  <td className="px-1 py-3">
                    <div>{a.owner?.name ?? "No users yet"}</div>
                    <div className="text-xs text-muted">{a.owner?.email ?? ""}</div>
                  </td>
                  <td className="px-1 py-3">
                    <div className="flex flex-wrap gap-1"><Badge status={a.status} />{a.securityState !== "ACTIVE" && <Badge status={a.securityState} />}</div>
                  </td>
                  <td className="num px-1 py-3 text-right">
                    <div className="font-semibold">{money(a.balanceMinor, a.currency)}</div>
                    <div className="text-xs text-muted">of {money(a.creditLimitMinor, a.currency)}</div>
                  </td>
                  <td className="px-1 py-3 text-muted">{a.rep?.name ?? "Unassigned"}</td>
                  <td className="px-1 py-3 text-xs text-muted">{relative(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {open && <AccountDrawer id={open} isAdmin={isAdmin} onClose={() => setOpen(null)} onChanged={() => { void list.reload(); void all.reload(); }} />}
      {creating && <CreateAccount onClose={() => setCreating(false)} onCreated={() => { void list.reload(); void all.reload(); }} />}
    </div>
  );
}

function TermsFields({ value, onChange, tiers, reps }: { value: TermsForm; onChange: (v: TermsForm) => void; tiers: Tier[]; reps: Array<{ id: string; name: string }> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Price tier" hint={tiers.length ? undefined : "Create tiers in Catalogue"}>
        <select className={inputCls} value={value.priceTierId} onChange={(e) => onChange({ ...value, priceTierId: e.target.value })}>
          <option value="">List prices only</option>
          {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <Field label="Account manager">
        <select className={inputCls} value={value.repId} onChange={(e) => onChange({ ...value, repId: e.target.value })}>
          <option value="">Unassigned</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Credit limit">
        <input className={`${inputCls} num`} inputMode="decimal" value={value.creditLimit} onChange={(e) => onChange({ ...value, creditLimit: e.target.value })} />
      </Field>
      <Field label="Payment terms (days)">
        <input className={`${inputCls} num`} inputMode="numeric" value={value.terms} onChange={(e) => onChange({ ...value, terms: e.target.value.replace(/\D/g, "") })} />
      </Field>
    </div>
  );
}

type TermsForm = { priceTierId: string; repId: string; creditLimit: string; terms: string };
const toTerms = (f: TermsForm): Terms | null => {
  const credit = parseMoney(f.creditLimit);
  if (credit === null) return null;
  return { priceTierId: f.priceTierId || null, repId: f.repId || null, creditLimitMinor: credit, paymentTermsDays: Number(f.terms || 0) };
};
const formFrom = (a: AccountRow): TermsForm => ({ priceTierId: a.priceTierId ?? "", repId: a.rep?.id ?? "", creditLimit: toMoneyInput(a.creditLimitMinor), terms: String(a.paymentTermsDays) });

function useRefs() {
  const tiers = useLoad(() => admin.products().then((p) => p.tiers), []);
  const reps = useLoad(() => admin.reps().then((r) => r.reps), []);
  return { tiers: tiers.data ?? [], reps: reps.data ?? [] };
}

function AccountDrawer({ id, isAdmin, onClose, onChanged }: { id: string; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const detail = useLoad(() => admin.account(id), [id]);
  const refs = useRefs();
  const [tab, setTab] = useState<"overview" | "order" | "users" | "pricing" | "statement" | "devices">("overview");
  const act = useAction();
  const [form, setForm] = useState<TermsForm | null>(null);
  const [reason, setReason] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [price, setPrice] = useState({ sku: "", minQty: "1", unit: "" });
  const [entry, setEntry] = useState({ kind: "PAYMENT", reference: "", amount: "", increase: false });

  const d = detail.data;
  const a = d?.account;
  const f = form ?? (a ? formFrom(a) : null);
  const refresh = async () => {
    await detail.reload();
    onChanged();
  };

  return (
    <Modal title={a ? a.legalName : "Trade account"} onClose={onClose} wide>
      {!d || !a || !f ? (
        <p className="text-sm text-muted">{detail.error ?? "Loading…"}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="font-mono">{a.code}</span>
            <Badge status={a.status} />
            {a.securityState !== "ACTIVE" && <Badge status={a.securityState} />}
            {a.phone && <span>· {a.phone}</span>}
            <span>· applied {shortDate(a.createdAt)}</span>
          </div>
          {a.statusReason && <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">Reason: {a.statusReason}</p>}

          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Terms" },
              ...(a.status === "APPROVED" && a.securityState === "ACTIVE" ? [{ value: "order" as const, label: "New order" }] : []),
              { value: "users", label: "People", count: d.users.length },
              { value: "pricing", label: "Contract prices", count: d.prices.length },
              { value: "statement", label: "Statement" },
              { value: "devices", label: "Devices", count: d.devices.length },
            ]}
          />
          <ErrorText error={act.error} />

          {tab === "overview" && (
            <div className="space-y-4">
              <TermsFields value={f} onChange={setForm} tiers={refs.tiers} reps={refs.reps} />
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div className="glass-inset px-3 py-2"><div className="label">Balance</div><div className="num font-semibold">{money(a.balanceMinor, a.currency)}</div></div>
                <div className="glass-inset px-3 py-2"><div className="label">Orders</div><div className="num font-semibold">{a.orders}</div></div>
                <div className="glass-inset px-3 py-2"><div className="label">People</div><div className="num font-semibold">{a.users}</div></div>
                <div className="glass-inset px-3 py-2"><div className="label">Approved</div><div className="font-semibold">{a.approvedAt ? shortDate(a.approvedAt) : "—"}</div></div>
              </div>
              {isAdmin && (
                <>
                  <Field label="Reason (shown to the customer when rejecting or suspending)">
                    <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                  </Field>
                  <div className="flex flex-wrap justify-end gap-2">
                    {a.securityState !== "ACTIVE" && (
                      <button className="btn-ghost" disabled={!!act.busy || reason.trim().length < 5} title="Use only for a confirmed false positive"
                        onClick={() => void act.run("unlock", () => admin.unlock(a.id, reason)).then((ok) => ok && refresh())}>
                        <ShieldOff className="h-4 w-4" /> Override security lock
                      </button>
                    )}
                    {a.status === "PENDING_APPROVAL" && (
                      <button className="btn-ghost text-danger" disabled={!!act.busy} onClick={() => void act.run("reject", () => admin.setStatus(a.id, "reject", reason || undefined)).then((ok) => ok && refresh())}>Reject</button>
                    )}
                    {a.status === "APPROVED" && (
                      <button className="btn-ghost text-danger" disabled={!!act.busy} onClick={() => void act.run("suspend", () => admin.setStatus(a.id, "suspend", reason || undefined)).then((ok) => ok && refresh())}>Suspend</button>
                    )}
                    {(a.status === "SUSPENDED" || a.status === "REJECTED") && (
                      <button className="btn-ghost" disabled={!!act.busy} onClick={() => void act.run("reactivate", () => admin.setStatus(a.id, "reactivate")).then((ok) => ok && refresh())}>Reactivate</button>
                    )}
                    {a.status === "PENDING_APPROVAL" ? (
                      <button className="btn-primary" disabled={!!act.busy} onClick={() => {
                        const t = toTerms(f);
                        if (!t) return act.setError("Enter a valid credit limit.");
                        void act.run("approve", () => admin.approve(a.id, t)).then((ok) => ok && refresh());
                      }}>{act.busy === "approve" ? "Approving…" : "Approve account"}</button>
                    ) : (
                      <button className="btn-primary" disabled={!!act.busy || !form} onClick={() => {
                        const t = toTerms(f);
                        if (!t) return act.setError("Enter a valid credit limit.");
                        void act.run("save", () => admin.updateAccount(a.id, t)).then((ok) => ok && (setForm(null), refresh()));
                      }}>{act.busy === "save" ? "Saving…" : "Save terms"}</button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "order" && <OrderForCustomer account={a} onPlaced={() => void refresh()} />}

          {tab === "users" && (
            <div className="space-y-3">
              <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
                {d.users.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{u.name} {u.owner && <span className="text-[11px] text-accent">· owner</span>}</div>
                      <div className="text-xs text-muted">{u.email} · {u.lastLoginAt ? `last signed in ${relative(u.lastLoginAt)}` : "never signed in"}</div>
                    </div>
                    {!u.active && <Badge label="Deactivated" tone="danger" />}
                    {isAdmin && (
                      <>
                        <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!act.busy} title="Lost authenticator: they set up a new one at next web sign-in"
                          onClick={() => window.confirm(`Reset two-step verification for ${u.name}? They'll be signed out and must set up their authenticator again.`) && void act.run(`mfa:${u.id}`, () => admin.resetMfa(u.id)).then((ok) => ok && refresh())}>
                          Reset 2-step
                        </button>
                        <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!act.busy} onClick={() => void act.run(u.id, () => admin.setUserActive(u.id, !u.active)).then((ok) => ok && refresh())}>
                          {u.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </>
                    )}
                  </li>
                ))}
                {d.pendingInvites.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1"><div className="font-medium">{i.email}</div><div className="text-xs text-muted">Invited · expires {shortDate(i.expiresAt)}</div></div>
                    <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void act.run(i.id, () => admin.revokeInvite(i.id)).then((ok) => ok && refresh())}>Revoke</button>
                  </li>
                ))}
              </ul>
              {a.status === "APPROVED" && (
                <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => {
                  e.preventDefault();
                  void act.run("invite", async () => setInviteUrl((await admin.inviteBuyer(a.id, inviteEmail)).inviteUrl)).then((ok) => ok && (setInviteEmail(""), refresh()));
                }}>
                  <input className={inputCls} type="email" required placeholder="buyer@company.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                  <button className="btn-primary shrink-0" disabled={!!act.busy}><UserPlus className="h-4 w-4" /> Invite buyer</button>
                </form>
              )}
              {inviteUrl && <CopyLink url={inviteUrl} note="Invitation emailed. You can also send this one-time link directly (valid 7 days)." />}
            </div>
          )}

          {tab === "pricing" && (
            <div className="space-y-3">
              {d.prices.length === 0 && <p className="text-sm text-muted">No negotiated prices. This account pays its tier price, or list price without a tier.</p>}
              <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
                {d.prices.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1"><div className="font-mono text-xs font-semibold">{p.sku}</div><div className="truncate text-xs text-muted">{p.name}</div></div>
                    <span className="text-xs text-muted">from {p.minQty}</span>
                    <span className="num w-24 text-right font-semibold">{money(p.unitMinor, a.currency)}</span>
                    <span className="num hidden w-20 text-right text-xs text-muted line-through sm:block">{money(p.listMinor, a.currency)}</span>
                    {isAdmin && (
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Remove ${p.sku} price`} title="Remove"
                        onClick={() => void act.run(p.id, () => admin.removeContractPrice(p.id)).then((ok) => ok && refresh())}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {isAdmin && (
                <form className="grid gap-2 sm:grid-cols-[1fr_90px_120px_auto]" onSubmit={(e) => {
                  e.preventDefault();
                  const unit = parseMoney(price.unit);
                  if (unit === null) return act.setError("Enter a valid unit price.");
                  void act.run("price", () => admin.setContractPrice(a.id, { sku: price.sku.trim(), minQty: Number(price.minQty || 1), unitMinor: unit })).then((ok) => ok && (setPrice({ sku: "", minQty: "1", unit: "" }), refresh()));
                }}>
                  <input className={`${inputCls} font-mono uppercase`} placeholder="SKU" required value={price.sku} onChange={(e) => setPrice({ ...price, sku: e.target.value })} />
                  <input className={`${inputCls} num`} placeholder="Min qty" inputMode="numeric" value={price.minQty} onChange={(e) => setPrice({ ...price, minQty: e.target.value.replace(/\D/g, "") })} aria-label="Minimum quantity" />
                  <input className={`${inputCls} num`} placeholder="Unit price" inputMode="decimal" required value={price.unit} onChange={(e) => setPrice({ ...price, unit: e.target.value })} aria-label="Unit price" />
                  <button className="btn-primary" disabled={!!act.busy}>Set price</button>
                </form>
              )}
            </div>
          )}

          {tab === "statement" && (
            <div className="space-y-3">
              <ul className="max-h-72 divide-y divide-line/60 overflow-y-auto dark:divide-line/[0.07]">
                {d.ledger.length === 0 && <li className="py-4 text-sm text-muted">No statement entries yet.</li>}
                {d.ledger.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1"><div className="font-medium">{l.kind.replace(/_/g, " ").toLowerCase()} <span className="font-mono text-xs text-muted">{l.reference}</span></div><div className="text-xs text-muted">{shortDate(l.postedAt)}{l.dueAt ? ` · due ${shortDate(l.dueAt)}` : ""}</div></div>
                    <span className={`num font-semibold ${l.amountMinor < 0 ? "text-ok" : ""}`}>{money(l.amountMinor, a.currency)}</span>
                  </li>
                ))}
              </ul>
              {isAdmin && (
                <form className="grid gap-2 sm:grid-cols-[minmax(12rem,max-content)_1fr_130px_auto]" onSubmit={(e) => {
                  e.preventDefault();
                  const amount = parseMoney(entry.amount);
                  if (amount === null || amount === 0) return act.setError("Enter an amount.");
                  void act.run("ledger", () => admin.postLedger(a.id, { kind: entry.kind, reference: entry.reference, amountMinor: amount, increase: entry.increase })).then((ok) => ok && (setEntry({ ...entry, reference: "", amount: "" }), refresh()));
                }}>
                  <select className={`${inputCls} pr-9`} value={entry.kind} onChange={(e) => setEntry({ ...entry, kind: e.target.value })} aria-label="Entry type">
                    <option value="PAYMENT">Payment received</option>
                    <option value="CREDIT_NOTE">Credit note</option>
                    <option value="INVOICE">Invoice</option>
                    <option value="ADJUSTMENT">Adjustment</option>
                  </select>
                  <input className={inputCls} placeholder="Reference" required value={entry.reference} onChange={(e) => setEntry({ ...entry, reference: e.target.value })} />
                  <input className={`${inputCls} num`} placeholder="Amount" inputMode="decimal" required value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} aria-label="Amount" />
                  <button className="btn-primary" disabled={!!act.busy}>Post</button>
                  {entry.kind === "ADJUSTMENT" && (
                    <label className="flex items-center gap-2 text-xs text-muted sm:col-span-4">
                      <input type="checkbox" checked={entry.increase} onChange={(e) => setEntry({ ...entry, increase: e.target.checked })} /> Adjustment increases what the customer owes
                    </label>
                  )}
                </form>
              )}
            </div>
          )}

          {tab === "devices" && (
            <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
              {d.devices.length === 0 && <li className="py-4 text-sm text-muted">No desktop installs connected.</li>}
              {d.devices.map((dv) => (
                <li key={dv.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1"><div className="font-medium">{dv.label}</div><div className="text-xs text-muted">{dv.user} · v{dv.version}{dv.lastAttestedAt ? ` · checked ${relative(dv.lastAttestedAt)}` : ""}</div></div>
                  <Badge status={dv.status} />
                  {isAdmin && dv.status !== "RETIRED" && (
                    <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void act.run(dv.id, () => admin.revokeDevice(dv.id)).then((ok) => ok && refresh())}>Revoke</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function CreateAccount({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const refs = useRefs();
  const act = useAction();
  const [legalName, setLegalName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [terms, setTerms] = useState<TermsForm>({ priceTierId: "", repId: "", creditLimit: "0.00", terms: "30" });
  const [result, setResult] = useState<{ code: string; inviteUrl: string } | null>(null);

  return (
    <Modal title="Open a trade account" onClose={onClose}>
      {result ? (
        <div className="space-y-4">
          <p className="text-sm">Account <span className="font-mono font-semibold">{result.code}</span> is open and approved. The contact has been emailed an invitation.</p>
          <CopyLink url={result.inviteUrl} note="One-time setup link for the account contact (valid 7 days)." />
          <button className="btn-primary w-full" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          const t = toTerms(terms);
          if (!t) return act.setError("Enter a valid credit limit.");
          void act.run("create", async () => {
            const r = await admin.createAccount({ ...t, legalName, ownerName, ownerEmail, phone: phone || null });
            setResult(r);
            onCreated();
          });
        }}>
          <Field label="Registered company name"><input className={inputCls} required value={legalName} onChange={(e) => setLegalName(e.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Contact name"><input className={inputCls} required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></Field>
            <Field label="Phone (optional)"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          </div>
          <Field label="Contact email"><input className={inputCls} type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} /></Field>
          <TermsFields value={terms} onChange={setTerms} tiers={refs.tiers} reps={refs.reps} />
          <ErrorText error={act.error} />
          <button className="btn-primary w-full" disabled={!!act.busy}>{act.busy ? "Opening…" : "Open account and invite contact"}</button>
        </form>
      )}
    </Modal>
  );
}

/** Staff places an order for the customer: their catalogue and price breaks, their credit check. */
function OrderForCustomer({ account, onPlaced }: { account: AccountRow; onPlaced: () => void }) {
  const cat = useLoad(() => admin.accountCatalogue(account.id), [account.id]);
  const skuRef = useRef<HTMLInputElement>(null);
  const available = Math.max(account.creditLimitMinor - account.balanceMinor, 0);
  if (!cat.data) return <p className="text-sm text-muted">{cat.error ?? "Loading this customer's catalogue…"}</p>;
  if (!cat.data.catalogue.length) return <p className="text-sm text-muted">No active products yet. Add products in Catalogue first.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Prices are {account.legalName}'s own (contract, then tier, then list). Orders over their credit go to Orders for approval, and the customer is emailed.
      </p>
      <QuickOrder
        ref={skuRef}
        catalogue={cat.data.catalogue}
        currency={account.currency}
        availableCreditMinor={available}
        allowQuote={false}
        poPlaceholder="Customer's PO reference (optional)"
        onQuote={async () => ""}
        onPlace={async (lines, po, mode) => {
          const r = await admin.orderForAccount(account.id, lines, po, mode);
          onPlaced();
          const what = r.status === "PENDING_APPROVAL" ? "is over their credit limit and waiting for approval in Orders" : r.status === "DRAFT" ? "saved as a draft" : "submitted";
          return `Order ${r.number} for ${account.legalName} ${what}.`;
        }}
      />
    </div>
  );
}
