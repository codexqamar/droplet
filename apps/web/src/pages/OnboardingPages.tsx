import { CheckCircle2, KeyRound, UserPlus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, auth } from "../lib/api";
import { navigate } from "../lib/nav";
import { AuthShell } from "./AuthPages";

const input = "glass-strong mt-1 h-11 w-full px-3.5 text-sm";

function PasswordPair({ password, confirm, setPassword, setConfirm }: { password: string; confirm: string; setPassword: (v: string) => void; setConfirm: (v: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block"><span className="label">Password</span><input className={input} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /><span className="mt-1 block text-[11px] text-muted">At least 12 characters</span></label>
      <label className="block"><span className="label">Confirm password</span><input className={input} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    </div>
  );
}

const setupErrors: Record<string, string> = {
  SETUP_LINK_INVALID: "This setup link is invalid or has expired. Ask your DROPLET provider for a new one.",
  SETUP_ALREADY_COMPLETE: "Setup is already complete. Sign in with your administrator account.",
  EMAIL_IN_USE: "That email already has an account.",
};

/** First-run: the one-time link from the DROPLET operator creates this business's first admin. */
export function SetupPage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [f, setF] = useState({ businessName: "", fullName: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    void auth.profile().then((p) => setClosed(!p.needsSetup)).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password.length < 12) return setError("Use a password of at least 12 characters.");
    if (f.password !== f.confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await auth.setup({ token, businessName: f.businessName, fullName: f.fullName, email: f.email, password: f.password });
      setDone(true);
    } catch (err) {
      const a = err as ApiError;
      setError(setupErrors[a.code] ?? a.message);
    } finally {
      setBusy(false);
    }
  }

  if (done || closed) {
    return (
      <AuthShell>
        <CheckCircle2 className="h-8 w-8 text-ok" />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">{done ? "Your admin account is ready" : "Setup is already complete"}</h1>
        <p className="mt-2 text-sm text-muted">{done ? "Sign in to open the admin portal. You'll be asked to turn on two-step verification first." : "Sign in with your administrator account."}</p>
        <button className="btn-primary mt-6 w-full" onClick={() => navigate("/login")}>Sign in</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell wide>
      <KeyRound className="h-7 w-7 text-accent" />
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Set up your trade portal</h1>
      <p className="mt-1 text-sm text-muted">Create the first administrator. You'll approve trade customers and invite your team from the admin portal.</p>
      {!token && <p className="mt-4 rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">Open the one-time setup link you were sent. It contains the setup code.</p>}
      <form onSubmit={submit} className="mt-6 space-y-3">
        <label className="block"><span className="label">Business name</span><input className={input} required minLength={2} autoComplete="organization" value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} autoFocus /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Your full name</span><input className={input} required minLength={2} autoComplete="name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
          <label className="block"><span className="label">Work email</span><input className={input} type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        <PasswordPair password={f.password} confirm={f.confirm} setPassword={(v) => setF({ ...f, password: v })} setConfirm={(v) => setF({ ...f, confirm: v })} />
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || !token}>{busy ? "Creating…" : "Create administrator"}</button>
      </form>
    </AuthShell>
  );
}

const roleText = { ADMIN: "an administrator", SALES_REP: "an account manager", TRADE_CUSTOMER: "a buyer" } as const;

/** Invitation acceptance for staff and trade buyers. */
export function InvitePage() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [info, setInfo] = useState<Awaited<ReturnType<typeof auth.invite>> | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return setInvalid(true);
    void auth.invite(token).then((i) => {
      setInfo(i);
      setFullName(i.fullName ?? "");
    }).catch(() => setInvalid(true));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) return setError("Use a password of at least 12 characters.");
    if (password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await auth.acceptInvite(token, fullName, password);
      setDone(true);
    } catch (err) {
      setError((err as ApiError).code === "INVITE_INVALID" ? "This invitation has expired or was already used." : (err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <AuthShell>
        <h1 className="text-xl font-semibold tracking-tight">Invitation not valid</h1>
        <p className="mt-2 text-sm text-muted">This link has expired or was already used. Ask whoever invited you to send a new one.</p>
        <button className="btn-ghost mt-6 w-full" onClick={() => navigate("/")}>Back to home</button>
      </AuthShell>
    );
  }
  if (done) {
    return (
      <AuthShell>
        <CheckCircle2 className="h-8 w-8 text-ok" />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">You're all set</h1>
        <p className="mt-2 text-sm text-muted">Sign in with {info?.email} to continue.</p>
        <button className="btn-primary mt-6 w-full" onClick={() => navigate("/login")}>Sign in</button>
      </AuthShell>
    );
  }
  return (
    <AuthShell wide>
      <UserPlus className="h-7 w-7 text-accent" />
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Join {info?.accountName ?? info?.business ?? "the portal"}</h1>
      <p className="mt-1 text-sm text-muted">{info ? `You've been invited as ${roleText[info.role]}${info.accountName ? ` on ${info.accountName}` : ""}. Set your name and password to finish.` : "Checking your invitation…"}</p>
      {info && (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <label className="block"><span className="label">Email</span><input className={`${input} opacity-70`} value={info.email} disabled /></label>
          <label className="block"><span className="label">Full name</span><input className={input} required minLength={2} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <PasswordPair password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Create my account"}</button>
        </form>
      )}
    </AuthShell>
  );
}
