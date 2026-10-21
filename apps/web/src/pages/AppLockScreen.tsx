import { ArrowLeft, KeyRound, LifeBuoy, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, desktop } from "../lib/api";
import { AuthShell } from "./AuthPages";

const messages: Record<string, string> = {
  INVALID_CREDENTIALS: "That password isn't right.",
  INVALID_MFA_CODE: "That code isn't right. Codes change every 30 seconds.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait 15 minutes and try again.",
  MFA_NOT_SET_UP: "Two-step verification isn't set up for this account. Sign in to the web portal to set up your authenticator app, then unlock here.",
  OFFLINE: "Unlocking needs an internet connection. Connect and try again.",
};

/**
 * Desktop app lock. Unlocking always checks with the cloud: the account's portal password,
 * then the code from their authenticator app. There is no offline or local bypass.
 */
export function AppLockScreen({ owner, onUnlocked, onRevoked }: { owner: { name?: string; email?: string } | null; onUnlocked: () => void; onRevoked: () => void }) {
  const [step, setStep] = useState<"password" | "code">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await desktop.unlock(password, step === "code" ? code : undefined);
      if (r.ok) {
        setPassword("");
        onUnlocked();
      } else if (r.mfaRequired) {
        setStep("code");
      }
    } catch (err) {
      const a = err as ApiError;
      if (a.code === "DEVICE_REVOKED") return onRevoked();
      const key = Object.keys(messages).find((k) => a.code === k || a.message === k || a.message.includes(k));
      setError(key ? messages[key]! : "DROPLET couldn't check that right now. Try again.");
      if (a.code === "INVALID_CREDENTIALS" || a.message.includes("INVALID_CREDENTIALS")) {
        setStep("password");
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent text-onaccent">
        <Lock className="h-5 w-5" />
      </span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{step === "password" ? "DROPLET is locked" : "Two-step verification"}</h1>
      <p className="mt-1 text-sm text-muted">
        {step === "password"
          ? `Enter the password for ${owner?.email ?? "this trade account"} to unlock.`
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        {step === "password" ? (
          <label className="block">
            <span className="label">Password</span>
            <input type="password" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} className="glass-strong mt-1 h-11 w-full px-3.5 text-sm" />
          </label>
        ) : (
          <label className="block">
            <span className="label">Authenticator code</span>
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="glass-strong num mt-1 h-11 w-full px-3.5 text-center text-sm tracking-[0.4em]" />
          </label>
        )}
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || (step === "code" && code.length !== 6) || !password}>
          <KeyRound className="h-4 w-4" /> {busy ? "Checking…" : step === "password" ? "Continue" : "Unlock"}
        </button>
      </form>
      <div className="mt-5 flex items-center justify-between gap-3 whitespace-nowrap text-xs text-muted">
        {step === "code" ? (
          <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => { setStep("password"); setCode(""); setError(null); }}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        ) : <span className="min-w-0 truncate" title={owner?.name}>{owner?.name ?? ""}</span>}
        <button className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline" onClick={() => setHelp((v) => !v)}>
          <LifeBuoy className="h-3.5 w-3.5 shrink-0" /> Lost your authenticator?
        </button>
      </div>
      {help && (
        <div className="mt-3 rounded-xl bg-surface/60 p-3 text-xs leading-relaxed text-muted">
          Ask an administrator at your supplier to reset two-step verification on your account. Then sign in to the web portal with
          your password, set up your authenticator app again, and come back here to unlock. For security, DROPLET can't be unlocked
          without your authenticator.
        </div>
      )}
    </AuthShell>
  );
}
