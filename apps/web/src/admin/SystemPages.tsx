import { Building2, FileClock, FlaskConical, KeyRound, PackageCheck, ShieldAlert, UserPlus } from "lucide-react";
import { useState } from "react";
import { StatCard } from "../components/StatCard";
import { admin, type Overview } from "../lib/admin";
import { relative, shortDate } from "../lib/format";
import { Badge, CopyLink, EmptyState, ErrorText, Field, inputCls, Modal, PageHeading, Panel, Segmented, useAction, useLoad } from "./ui";

const actionText: Record<string, string> = {
  "account.apply": "applied for a trade account",
  "account.approve": "approved account",
  "account.reject": "rejected application",
  "account.suspend": "suspended account",
  "account.reactivate": "reactivated account",
  "account.create": "opened account",
  "account.update": "updated account terms",
  "auth.login": "signed in",
  "order.web": "placed an order",
  "order.desktop": "placed an order from desktop",
  "order.sync_push": "synced an order from desktop",
  "quote.request": "requested a quote",
  "quote.offer": "sent a quote offer",
  "quote.accept": "accepted quote",
  "setup.complete": "completed first-time setup",
  "security.lock": "security lock triggered",
  "device.enroll": "connected a desktop app",
  "auth.mfa_enrolled": "turned on two-step verification",
  "user.reset_mfa": "reset two-step verification for",
  "device.unlock": "unlocked the desktop app",
  "invite.accept": "accepted an invitation",
  "team.invite": "invited a staff member",
  "account.invite_user": "invited a buyer",
  "order.submitted": "approved order",
  "order.confirmed": "confirmed order",
  "order.shipped": "shipped order",
  "order.part_shipped": "part-shipped order",
  "order.invoiced": "invoiced order",
  "order.cancelled": "cancelled order",
  "product.create": "added product",
  "product.update": "updated product",
  "price.tier_set": "updated tier prices",
  "price.contract_set": "set a contract price",
  "ledger.post": "posted a statement entry",
};
export const describe = (a: string) => actionText[a] ?? a.replace(/[._]/g, " ");

export function OverviewPage({ data, go }: { data: Overview; go: (page: string) => void }) {
  const c = data.counts;
  const isAdmin = data.me.role === "ADMIN";
  return (
    <div className="space-y-5">
      <PageHeading title={`${data.business} admin`} description={isAdmin ? "Everything that needs a decision today, across every trade account." : "Your assigned trade accounts at a glance."} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <button className="text-left" onClick={() => go("accounts")}>
          <StatCard icon={Building2} label="Applications" value={String(c.pendingApplications).padStart(2, "0")} foot={`${c.activeAccounts} active account${c.activeAccounts === 1 ? "" : "s"}`} badge={c.pendingApplications ? "Review" : undefined} />
        </button>
        <button className="text-left" onClick={() => go("orders")}>
          <StatCard icon={PackageCheck} label="Orders to approve" value={String(c.ordersAwaitingApproval).padStart(2, "0")} foot={`${c.openOrders} open order${c.openOrders === 1 ? "" : "s"}`} badge={c.ordersAwaitingApproval ? "Action" : undefined} />
        </button>
        <button className="text-left" onClick={() => go("quotes")}>
          <StatCard icon={FileClock} label="Quotes to price" value={String(c.openQuotes).padStart(2, "0")} foot="Requested or in review" badge={c.openQuotes ? "New" : undefined} />
        </button>
        {isAdmin && (
          <button className="text-left" onClick={() => go("security")}>
            <StatCard icon={ShieldAlert} label="Security incidents" value={String(c.openIncidents).padStart(2, "0")} foot={c.openIncidents ? "Accounts locked" : "All clear"} badge={c.openIncidents ? "Alert" : undefined} />
          </button>
        )}
      </div>
      <Panel title="Recent activity">
        {data.activity.length === 0 ? (
          <EmptyState icon={FileClock} title="No activity yet" body="Sign-ins, applications, orders and approvals will appear here." />
        ) : (
          <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
            {data.activity.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate"><span className="font-medium">{a.actor}</span> <span className="text-muted">{describe(a.action)}</span> {a.target && <span className="font-mono text-xs">{a.target}</span>}</span>
                <span className="shrink-0 text-xs text-muted">{relative(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function TeamPage({ myId }: { myId: string }) {
  const team = useLoad(() => admin.team(), []);
  const act = useAction();
  const [inviting, setInviting] = useState(false);
  return (
    <div className="space-y-5">
      <PageHeading title="Team" description="Administrators manage everything. Account managers see only the trade accounts assigned to them." action={<button className="btn-primary" onClick={() => setInviting(true)}><UserPlus className="h-4 w-4" /> Invite staff</button>} />
      <ErrorText error={act.error ?? team.error} />
      <Panel>
        <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
          {team.data?.staff.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}</div>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{u.name}{u.id === myId && <span className="text-xs text-muted"> · you</span>}</div>
                <div className="text-xs text-muted">{u.email} · {u.lastLoginAt ? `signed in ${relative(u.lastLoginAt)}` : "never signed in"}{u.role === "SALES_REP" ? ` · ${u.accounts} account${u.accounts === 1 ? "" : "s"}` : ""}</div>
              </div>
              <Badge status={u.role} />
              {!u.mfa && <Badge label="No 2-step yet" tone="warn" />}
              {!u.active && <Badge label="Deactivated" tone="danger" />}
              {u.id !== myId && u.mfa && (
                <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!act.busy} title="Lost authenticator: they set up a new one at next sign-in"
                  onClick={() => window.confirm(`Reset two-step verification for ${u.name}? They'll be signed out and must set up their authenticator again.`) && void act.run(`mfa:${u.id}`, () => admin.resetMfa(u.id)).then((ok) => ok && team.reload())}>
                  Reset 2-step
                </button>
              )}
              {u.id !== myId && (
                <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!act.busy} onClick={() => void act.run(u.id, () => admin.setUserActive(u.id, !u.active)).then((ok) => ok && team.reload())}>
                  {u.active ? "Deactivate" : "Reactivate"}
                </button>
              )}
            </li>
          ))}
          {team.data?.invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium">{i.email}</div><div className="text-xs text-muted">Invitation pending · expires {shortDate(i.expiresAt)}</div></div>
              <Badge status={i.role} />
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void act.run(i.id, () => admin.revokeInvite(i.id)).then((ok) => ok && team.reload())}>Revoke</button>
            </li>
          ))}
        </ul>
      </Panel>
      {inviting && <InviteStaff onClose={() => setInviting(false)} onDone={() => void team.reload()} />}
    </div>
  );
}

function InviteStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<"SALES_REP" | "ADMIN">("SALES_REP");
  const [url, setUrl] = useState<string | null>(null);
  return (
    <Modal title="Invite a staff member" onClose={onClose}>
      {url ? (
        <div className="space-y-4">
          <CopyLink url={url} note={`Invitation emailed to ${email}. You can also send this one-time link (valid 7 days).`} />
          <button className="btn-primary w-full" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          void act.run("invite", async () => setUrl((await admin.inviteStaff(email, role, fullName || undefined)).inviteUrl)).then((ok) => ok && onDone());
        }}>
          <Field label="Name (optional)"><input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
          <Field label="Work email"><input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Role" hint={role === "ADMIN" ? "Full access to every page, including team, security and settings." : "Sees only the trade accounts you assign, with their orders and quotes."}>
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="SALES_REP">Account manager</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </Field>
          <ErrorText error={act.error} />
          <button className="btn-primary w-full" disabled={!!act.busy}>{act.busy ? "Sending…" : "Send invitation"}</button>
        </form>
      )}
    </Modal>
  );
}

export function SecurityPage() {
  const data = useLoad(() => admin.security(), []);
  const audit = useLoad(() => admin.audit(), []);
  const act = useAction();
  const [tab, setTab] = useState<"devices" | "incidents" | "releases" | "audit">("devices");
  const d = data.data;
  return (
    <div className="space-y-5">
      <PageHeading title="Security" description="Desktop installs and their integrity checks, tamper incidents, signed releases and the full audit log." />
      {d?.mfaKeyFingerprint && (
        <div className="glass flex flex-col gap-1 px-4 py-3 text-xs sm:flex-row sm:items-center sm:gap-3">
          <KeyRound className="h-4 w-4 shrink-0 text-accent" />
          <span className="flex-1 text-muted">
            Two-step key fingerprint <code className="select-all font-mono text-ink">{d.mfaKeyFingerprint}</code>. Your backed-up <code className="font-mono">DROPLET_MFA_ENC_KEY</code> must produce the same fingerprint
            (<code className="font-mono">sha256</code>, first 16 characters); if the key is lost, every user has to set up their authenticator again.
          </span>
        </div>
      )}
      <Segmented value={tab} onChange={setTab} options={[
        { value: "devices", label: "Desktop installs" },
        { value: "incidents", label: "Incidents", count: d?.incidents.filter((i) => !i.resolvedAt).length },
        { value: "releases", label: "Releases" },
        { value: "audit", label: "Audit log" },
      ]} />
      <ErrorText error={act.error ?? data.error} />
      <Panel>
        {tab === "devices" && (d?.devices.length ? (
          <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
            {d.devices.map((dv) => (
              <li key={dv.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1"><div className="font-medium">{dv.label}</div><div className="text-xs text-muted">{dv.account} · {dv.user} · v{dv.version} · {dv.lastAttestedAt ? `checked ${relative(dv.lastAttestedAt)}` : "never checked in"}</div></div>
                <Badge status={dv.status} />
                {dv.status !== "RETIRED" && <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!act.busy} onClick={() => void act.run(dv.id, () => admin.revokeDevice(dv.id)).then((ok) => ok && data.reload())}>Revoke</button>}
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={KeyRound} title="No desktop installs yet" body="Installs appear here once a customer connects the desktop app." />)}

        {tab === "incidents" && (d?.incidents.length ? (
          <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
            {d.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1"><div className="font-medium">{i.account.name}</div><div className="text-xs text-muted">{i.kind.replace(/_/g, " ").toLowerCase()} · opened {relative(i.openedAt)}{i.resolvedAt ? ` · resolved ${relative(i.resolvedAt)}` : ""}</div></div>
                {i.resolvedAt ? <Badge label="Resolved" tone="ok" /> : <Badge status={i.account.state} />}
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={ShieldAlert} title="No incidents" body="If a desktop install reports modified files, the account locks and the incident is listed here." />)}

        {tab === "releases" && (d?.releases.length ? (
          <ul className="divide-y divide-line/60 dark:divide-line/[0.07]">
            {d.releases.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1"><div className="font-medium">v{r.version} <span className="font-mono text-xs text-muted">{r.buildId}</span></div><div className="text-xs text-muted">{r.platform} · published {shortDate(r.publishedAt)} · {r.devices} install{r.devices === 1 ? "" : "s"}</div></div>
                {r.revokedAt ? <Badge label="Withdrawn" tone="danger" /> : <Badge label="Current" tone="ok" />}
                {!r.revokedAt && <button className="btn-ghost px-3 py-1.5 text-xs text-danger" disabled={!!act.busy} title="Installs on this build must update" onClick={() => void act.run(r.id, () => admin.revokeRelease(r.id)).then((ok) => ok && data.reload())}>Withdraw</button>}
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={KeyRound} title="No releases" body="Signed desktop builds are registered by the release pipeline." />)}

        {tab === "audit" && (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <tbody>
                {audit.data?.entries.map((e) => (
                  <tr key={e.id} className="border-t border-line/50 first:border-0 dark:border-line/[0.06]">
                    <td className="whitespace-nowrap px-1 py-2 text-xs text-muted">{new Date(e.at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="px-1 py-2 font-medium">{e.actor}</td>
                    <td className="px-1 py-2 text-muted">{describe(e.action)}</td>
                    <td className="px-1 py-2 font-mono text-xs">{e.target ?? ""}</td>
                    <td className="px-1 py-2 text-right text-xs text-muted">{e.ip ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function DemoData({ loaded, onLoaded }: { loaded: boolean; onLoaded: () => void }) {
  const act = useAction();
  const [r, setR] = useState<Awaited<ReturnType<typeof admin.loadDemoData>> | null>(null);
  return (
    <Panel title="Demo data" action={<FlaskConical className="h-4 w-4 text-muted" />}>
      <p className="text-sm text-muted">This is a demo install. Load a sample plumbing &amp; heating catalogue across three branches, with trade accounts, contract prices, order history, saved lists and statements. Nothing existing is changed.</p>
      {!loaded && !r && (
        <button className="btn-primary mt-3" disabled={!!act.busy} onClick={() => void act.run("demo", async () => {
          setR(await admin.loadDemoData());
          onLoaded();
        })}>
          {act.busy ? "Loading…" : "Load demo data"}
        </button>
      )}
      {loaded && !r && <p className="mt-3 text-sm text-ok">Demo data is loaded.</p>}
      <ErrorText error={act.error} />
      {r?.loaded && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="font-medium text-ok">{r.message}</p>
          <p className="text-xs text-muted">Buyer sign-ins (copy the password now; it is not shown again):</p>
          <CopyLink url={r.password ?? ""} note="Password for every demo buyer" />
          <ul className="divide-y divide-line/60 text-xs dark:divide-line/[0.07]">
            {r.logins?.map((l) => (
              <li key={l.email} className="py-1.5"><span className="font-mono text-ink">{l.email}</span> <span className="text-muted">· {l.note}</span></li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const s = useLoad(() => admin.settings(), []);
  const act = useAction();
  const [f, setF] = useState<{ name: string; supportEmail: string; currency: string } | null>(null);
  const v = f ?? (s.data ? { name: s.data.name, supportEmail: s.data.supportEmail ?? "", currency: s.data.currency } : null);
  return (
    <div className="space-y-5">
      <PageHeading title="Settings" description="Your business details, shown to customers across the portal and in emails." />
      <Panel title="Business profile">
        {!v ? <p className="text-sm text-muted">{s.error ?? "Loading…"}</p> : (
          <form className="grid max-w-2xl gap-3 sm:grid-cols-2" onSubmit={(e) => {
            e.preventDefault();
            void act.run("save", () => admin.updateSettings({ name: v.name, supportEmail: v.supportEmail || null, currency: v.currency.toUpperCase() })).then((ok) => ok && (setF(null), s.reload(), onSaved()));
          }}>
            <div className="sm:col-span-2"><Field label="Business name"><input className={inputCls} required minLength={2} value={v.name} onChange={(e) => setF({ ...v, name: e.target.value })} /></Field></div>
            <Field label="Support email"><input className={inputCls} type="email" value={v.supportEmail} onChange={(e) => setF({ ...v, supportEmail: e.target.value })} /></Field>
            <Field label="Currency" hint="Applies to new trade accounts"><input className={`${inputCls} uppercase`} maxLength={3} value={v.currency} onChange={(e) => setF({ ...v, currency: e.target.value })} /></Field>
            <div className="sm:col-span-2"><ErrorText error={act.error} /></div>
            <div className="flex justify-end sm:col-span-2"><button className="btn-primary" disabled={!!act.busy || !f}>{act.busy ? "Saving…" : "Save"}</button></div>
          </form>
        )}
      </Panel>
      {s.data?.demoMode && <DemoData loaded={s.data.demoLoaded} onLoaded={() => (s.reload(), onSaved())} />}
      <Panel title="How onboarding works">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Customers apply from the portal's <span className="font-medium text-ink">Apply for an account</span> page, or you open an account for them in <span className="font-medium text-ink">Trade accounts</span>.</li>
          <li>You approve the application and set the price tier, credit limit, payment terms and account manager.</li>
          <li>The customer signs in, turns on two-step verification and can order straight away. Their desktop app installer is issued from their portal.</li>
          <li>Invite more administrators and account managers from <span className="font-medium text-ink">Team</span>.</li>
        </ol>
      </Panel>
    </div>
  );
}

