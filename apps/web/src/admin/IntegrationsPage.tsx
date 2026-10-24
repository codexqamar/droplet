import { CreditCard, Download, KeyRound, Mail, Plug, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { isDesktop } from "../lib/api";
import { admin } from "../lib/admin";
import { relative, shortDate } from "../lib/format";
import { Badge, CopyLink, ErrorText, Field, inputCls, PageHeading, Panel, useAction, useLoad } from "./ui";

/**
 * Accounting / ERP connections, email and payments status. Everything a distributor's finance or
 * IT team needs to connect DROPLET to Xero, Sage, QuickBooks or their own ERP.
 */
export function IntegrationsPage() {
  const data = useLoad(() => admin.integrations(), []);
  const act = useAction();
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [hook, setHook] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }));
  const d = data.data;

  return (
    <div className="space-y-5">
      <PageHeading title="Integrations" description="Connect your accounting system or ERP, and check email and online payments. Changes sync both ways: catalogue, prices and stock in; orders, invoices and payments out." />
      <ErrorText error={act.error ?? data.error} />
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-xs font-medium text-ok">{note}</p>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Email" action={<Mail className="h-4 w-4 text-muted" />}>
          {d && (
            <>
              <div className="flex items-center gap-2 text-sm">
                {d.mail.mode === "smtp" ? <Badge label="Connected" tone="ok" /> : <Badge label="Not connected" tone="warn" />}
                <span className="text-muted">{d.mail.mode === "smtp" ? `${d.mail.host ?? "SMTP"} · from ${d.mail.from ?? "default sender"}` : "Emails are written to the server log"}</span>
              </div>
              {d.mail.mode === "log" && (
                <p className="mt-2 text-xs text-muted">
                  Set <code className="font-mono">SMTP_URL</code> (e.g. <code className="font-mono">smtps://user:pass@smtp.postmarkapp.com:465</code>) and <code className="font-mono">MAIL_FROM</code> on the server to send invitations, order updates and security alerts.
                </p>
              )}
              <button className="btn-ghost mt-3" disabled={!!act.busy} onClick={() => void act.run("mail", async () => {
                const r = await admin.testMail();
                setNote(r.mode === "smtp" ? `Test email sent to ${r.to}.` : "Test email written to the server log (no SMTP configured).");
              })}>
                <Send className="h-4 w-4" /> Send test email
              </button>
            </>
          )}
        </Panel>

        <Panel title="Online payments" action={<CreditCard className="h-4 w-4 text-muted" />}>
          {d && (
            <>
              <div className="flex items-center gap-2 text-sm">
                {d.payments.provider === "stripe" ? <Badge label="Stripe" tone="ok" /> : d.payments.provider === "demo" ? <Badge label="Demo mode" tone="warn" /> : <Badge label="Off" tone="muted" />}
                <span className="text-muted">
                  {d.payments.enabled ? `Buyers can pay by ${d.payments.methods.map((m) => (m === "bacs_debit" ? "Direct Debit" : m)).join(" or ")} from their statement.` : "Buyers see their statement but cannot pay online."}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted">
                {d.payments.provider === "demo"
                  ? "Demo checkout: no money moves. Set STRIPE_SECRET_KEY to take real payments."
                  : "Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PAYMENT_METHODS=card,bacs_debit on the server. Webhook endpoint: "}
                {d.payments.provider !== "demo" && <code className="break-all font-mono">{d.apiBase.replace("/v1/integration", "")}/v1/payments/stripe/webhook</code>}
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel title="API keys" action={<KeyRound className="h-4 w-4 text-muted" />}>
        <p className="text-sm text-muted">
          For your ERP or accounting connector. Base URL <code className="break-all font-mono text-ink">{d?.apiBase}</code>; send <code className="font-mono">Authorization: Bearer dlk_…</code>.
          Endpoints: <code className="font-mono">PUT /products</code>, <code className="font-mono">PUT /stock</code>, <code className="font-mono">PUT /contract-prices</code>, <code className="font-mono">GET /orders</code>, <code className="font-mono">POST /orders/:number/status</code>, <code className="font-mono">GET /invoices</code>, <code className="font-mono">GET /payments</code>, <code className="font-mono">GET /accounts</code> (all accept <code className="font-mono">?since=</code>).
        </p>
        <ul className="mt-3 divide-y divide-line/60 text-sm dark:divide-line/[0.07]">
          {d?.apiKeys.length === 0 && <li className="py-3 text-muted">No keys yet.</li>}
          {d?.apiKeys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1"><div className="font-medium">{k.name}</div><div className="text-xs text-muted"><span className="font-mono">{k.prefix}…</span> · created {shortDate(k.createdAt)} · {k.lastUsedAt ? `used ${relative(k.lastUsedAt)}` : "never used"}</div></div>
              <button className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Revoke ${k.name}`} title="Revoke"
                onClick={() => window.confirm(`Revoke the key “${k.name}”? Anything using it stops working.`) && void act.run(k.id, () => admin.revokeApiKey(k.id)).then((ok) => ok && data.reload())}>
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <form className="mt-3 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          void act.run("key", async () => setNewKey((await admin.createApiKey(keyName.trim())).token)).then((ok) => ok && (setKeyName(""), data.reload()));
        }}>
          <input className={`${inputCls} max-w-xs`} placeholder="Key name, e.g. Xero sync" required minLength={2} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <button className="btn-primary shrink-0" disabled={!!act.busy}><Plug className="h-4 w-4" /> Create key</button>
        </form>
        {newKey && <div className="mt-3"><CopyLink url={newKey} note="Copy this key now. It is shown once and only its fingerprint is stored." /></div>}
      </Panel>

      <Panel title="Webhook" action={<Webhook className="h-4 w-4 text-muted" />}>
        <p className="text-sm text-muted">DROPLET posts <code className="font-mono">order.submitted</code>, <code className="font-mono">order.status</code>, <code className="font-mono">invoice.created</code> and <code className="font-mono">payment.succeeded</code> events, signed with <code className="font-mono">X-Droplet-Signature</code> (HMAC-SHA256).</p>
        <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => {
          e.preventDefault();
          const url = (hook ?? d?.webhook.url ?? "").trim();
          void act.run("hook", async () => setSecret((await admin.setWebhook(url || null)).secret)).then((ok) => ok && (setHook(null), data.reload()));
        }}>
          <input className={inputCls} type="url" placeholder="https://your-connector.example.com/droplet" value={hook ?? d?.webhook.url ?? ""} onChange={(e) => setHook(e.target.value)} />
          <button className="btn-primary shrink-0" disabled={!!act.busy || hook === null}>Save</button>
          <button type="button" className="btn-ghost shrink-0" disabled={!!act.busy || !d?.webhook.configured} onClick={() => void act.run("hooktest", async () => {
            const r = await admin.testWebhook();
            setNote(r.ok ? `Test event delivered (HTTP ${r.status}).` : `Test event failed: ${r.error ?? `HTTP ${r.status}`}`);
          })}>
            Send test
          </button>
        </form>
        {secret && <div className="mt-3"><CopyLink url={secret} note="Signing secret for verifying webhook calls. Shown once." /></div>}
      </Panel>

      {!isDesktop && (
        <Panel title="Accounting exports" action={<Download className="h-4 w-4 text-muted" />}>
          <div className="grid max-w-xl grid-cols-2 gap-3">
            <Field label="From"><input className={inputCls} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To"><input className={inputCls} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {([
              ["Invoices for Xero", "invoices", "xero"],
              ["Invoices for Sage", "invoices", "sage"],
              ["Invoices (CSV)", "invoices", "generic"],
              ["Payments for Sage", "payments", "sage"],
              ["Payments (CSV)", "payments", "generic"],
              ["Order lines (CSV)", "orders", "generic"],
            ] as const).map(([label, kind, format]) => (
              <a key={label} className="btn-ghost justify-start" href={admin.exportUrl(kind, format, range.from, range.to)} download>
                <Download className="h-4 w-4" /> {label}
              </a>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">Xero: Business › Invoices › Import. Sage: File › Import › Audit trail transactions. Adjust the nominal and account codes in the file to your chart of accounts.</p>
        </Panel>
      )}
    </div>
  );
}
