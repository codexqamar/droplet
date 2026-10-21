import { ArrowLeft, CheckCircle2, Clock3, Eye, EyeOff, KeyRound, LogIn } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Logo } from "../components/TopBar";
import { ApiError, auth } from "../lib/api";
import { navigate } from "../lib/nav";

export function AuthShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto flex min-h-screen flex-col justify-center px-4 py-10 ${wide ? "max-w-xl" : "max-w-md"}`}>
      <button className="mb-6 flex justify-center" onClick={() => navigate("/")} aria-label="DROPLET home">
        <Logo />
      </button>
      <div className="glass p-6 sm:p-8">{children}</div>
    </div>
  );
}

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; hint?: string; inputMode?: "numeric"; maxLength?: number; autoFocus?: boolean; mono?: boolean }) {
  const id = useId();
  const isPassword = props.type === "password";
  const [passwordVisible, setPasswordVisible] = useState(false);
  return (
    <div className="block">
      <label className="label" htmlFor={id}>{props.label}</label>
      <div className="relative mt-1">
        <input
          id={id}
          type={isPassword && passwordVisible ? "text" : props.type ?? "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete={props.autoComplete}
          inputMode={props.inputMode}
          maxLength={props.maxLength}
          autoFocus={props.autoFocus}
          required
          className={`glass-strong h-11 w-full px-3.5 text-sm ${isPassword ? "pr-12" : ""} ${props.mono ? "num tracking-[0.4em]" : ""}`}
        />
        {isPassword && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-2xl text-muted transition-colors hover:text-ink"
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={passwordVisible ? `Hide ${props.label.toLowerCase()}` : `Show ${props.label.toLowerCase()}`}
            aria-pressed={passwordVisible}
          >
            {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
      {props.hint && <span className="mt-1 block text-[11px] text-muted">{props.hint}</span>}
    </div>
  );
}

const loginErrors: Record<string, string> = {
  INVALID_CREDENTIALS: "That email and password don't match an account.",
  INVALID_MFA_CODE: "That code isn't right. Codes change every 30 seconds.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait 15 minutes and try again.",
};

export function LoginPage({ onSignedIn, onPending, onLocked, title = "Sign in to your trade portal", subtitle = "Use the email registered on your trade account.", footer }: {
  onSignedIn: () => void;
  onPending: (detail?: string) => void;
  onLocked: (state: string) => void;
  title?: string;
  subtitle?: string;
  footer?: ReactNode;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await auth.login(email, password, needsMfa ? totp : undefined);
      if (r.mfaRequired) setNeedsMfa(true);
      else onSignedIn();
    } catch (err) {
      const a = err as ApiError;
      if (a.code === "ACCOUNT_NOT_APPROVED") onPending(a.detail);
      else if (a.code === "ACCOUNT_SECURITY_LOCK") onLocked(a.detail ?? "LOCKED_TAMPER");
      else setError(loginErrors[a.code] ?? a.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold tracking-tight">{needsMfa ? "Two-step verification" : title}</h1>
      <p className="mt-1 text-sm text-muted">
        {needsMfa ? "Enter the 6-digit code from your authenticator app." : subtitle}
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        {needsMfa ? (
          <Field label="Authenticator code" value={totp} onChange={(v) => setTotp(v.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus mono />
        ) : (
          <>
            <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" autoFocus />
            <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          </>
        )}
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || (needsMfa && totp.length !== 6)}>
          {needsMfa ? <KeyRound className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
          {busy ? "Checking…" : needsMfa ? "Verify" : "Sign in"}
        </button>
      </form>
      <div className="mt-5 flex items-center justify-between text-xs text-muted">
        {needsMfa ? (
          <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => { setNeedsMfa(false); setTotp(""); }}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        ) : (
          footer ?? (
            <span>
              No account yet?{" "}
              <button className="font-medium text-accent hover:underline" onClick={() => navigate("/apply")}>Apply for one</button>
            </span>
          )
        )}
      </div>
    </AuthShell>
  );
}

export function ApplyPage() {
  const [form, setForm] = useState({ companyName: "", fullName: "", email: "", phone: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password.length < 12) return setError("Use a password of at least 12 characters.");
    if (form.password !== form.confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await auth.apply({ companyName: form.companyName, fullName: form.fullName, email: form.email, phone: form.phone || undefined, password: form.password });
      setDone(true);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <CheckCircle2 className="h-8 w-8 text-ok" />
        <h1 className="mt-3 text-xl font-semibold tracking-tight">Application received</h1>
        <p className="mt-2 text-sm text-muted">
          Our credit team reviews new trade accounts within one working day. We'll email {form.email} when your account is
          approved, and you can then sign in.
        </p>
        <button className="btn-ghost mt-6 w-full" onClick={() => navigate("/")}>Back to home</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell wide>
      <h1 className="text-xl font-semibold tracking-tight">Apply for a trade account</h1>
      <p className="mt-1 text-sm text-muted">Approved accounts get contract pricing, credit terms and the desktop app.</p>
      <form onSubmit={submit} className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Registered company name" value={form.companyName} onChange={set("companyName")} autoComplete="organization" autoFocus />
        </div>
        <Field label="Your full name" value={form.fullName} onChange={set("fullName")} autoComplete="name" />
        <label className="block">
          <span className="label">Phone (optional)</span>
          <input value={form.phone} onChange={(e) => set("phone")(e.target.value)} autoComplete="tel" className="glass-strong mt-1 h-11 w-full px-3.5 text-sm" />
        </label>
        <div className="sm:col-span-2">
          <Field label="Work email" type="email" value={form.email} onChange={set("email")} autoComplete="email" />
        </div>
        <Field label="Password" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" hint="At least 12 characters" />
        <Field label="Confirm password" type="password" value={form.confirm} onChange={set("confirm")} autoComplete="new-password" />
        {error && <p className="text-xs font-medium text-danger sm:col-span-2">{error}</p>}
        <button className="btn-primary sm:col-span-2" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</button>
      </form>
      <p className="mt-5 text-xs text-muted">
        Already approved?{" "}
        <button className="font-medium text-accent hover:underline" onClick={() => navigate("/login")}>Sign in</button>
      </p>
    </AuthShell>
  );
}

export function PendingPage() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const reason = params.get("reason");
  const closed = status === "REJECTED" || status === "SUSPENDED";
  return (
    <AuthShell>
      <Clock3 className={`h-8 w-8 ${closed ? "text-danger" : "text-warn"}`} />
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {status === "REJECTED" ? "Application not approved" : status === "SUSPENDED" ? "Account suspended" : "Your account is under review"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        {status === "REJECTED"
          ? "We couldn't open a trade account for your business this time."
          : status === "SUSPENDED"
            ? "Ordering on this account is paused. Contact your account manager to restore access."
            : "Your application hasn't been approved yet. You'll be able to sign in as soon as it's approved, and we'll email you."}
      </p>
      {reason && <p className="mt-3 rounded-xl bg-surface/60 px-3 py-2 text-xs">Reason: {reason}</p>}
      <button className="btn-ghost mt-6 w-full" onClick={() => navigate("/")}>Back to home</button>
    </AuthShell>
  );
}
