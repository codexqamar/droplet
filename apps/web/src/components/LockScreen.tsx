import { Download, Lock, Mail, RefreshCw, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { auth } from "../lib/api";
import { navigate } from "../lib/nav";
import type { SecurityState } from "../lib/types";
import { AuthShell } from "../pages/AuthPages";

interface RedeemResult {
  download: { url: string; sha256: string; version: string };
  enrollmentCode: string;
  instructions: string[];
}

const steps = ["Locked", "Verify identity", "Install clean build", "Unlocked"];
const stepIndex: Record<SecurityState, number> = {
  LOCKED_TAMPER: 0,
  RECOVERY_PENDING: 1,
  RECOVERY_VERIFIED: 2,
  AWAITING_CLEAN_INSTALL: 2,
  ACTIVE: 3,
};

/**
 * Shown when the API answers 423 ACCOUNT_SECURITY_LOCK, and at /security/recover?token=…
 * (the link in the tamper alert email). Recovery = emailed token + password + TOTP.
 * On desktop it only explains the lock: recovery always happens on the web portal.
 */
export function LockScreen({ state, token, desktop, onRetry }: { state: SecurityState; token: string | null; desktop?: boolean; onRetry?: () => void }) {
  const [password, setPassword] = useState("");
  const [mfa, setMfa] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [resendEmail, setResendEmail] = useState("");
  const [resent, setResent] = useState(false);
  const current = result ? 2 : stepIndex[state] ?? 0;

  async function redeem(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await auth.recoveryRedeem(token!, password, mfa));
    } catch {
      setError("Verification failed. Confirm your password and authenticator code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell wide>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-danger/10 text-danger">
          <ShieldAlert className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold">Account locked for your protection</h1>
          <p className="text-sm text-muted">A DROPLET desktop install reported modified program files.</p>
        </div>
      </div>

      <ol className="mt-6 grid grid-cols-4 gap-2">
        {steps.map((s, i) => (
          <li key={s} className="text-center">
            <div className={`h-1.5 rounded-full ${i <= current ? "bg-accent" : "bg-muted/20"}`} />
            <div className={`mt-1.5 text-[11px] ${i === current ? "font-semibold text-ink" : "text-muted"}`}>{s}</div>
          </li>
        ))}
      </ol>

      {desktop ? (
        <div className="mt-6 space-y-3 text-sm">
          <p>
            Ordering and sync are paused on every device. The account owner has been emailed a one-time recovery link. Open it
            in the DROPLET web portal, verify with password and authenticator, then install the clean build it provides.
          </p>
          <button className="btn-ghost w-full" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" /> Check again
          </button>
        </div>
      ) : result ? (
        <div className="mt-6 space-y-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {result.instructions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <a href={result.download.url} className="btn-primary w-full">
            <Download className="h-4 w-4" /> Download clean build v{result.download.version}
          </a>
          <div className="glass-inset space-y-1 px-3 py-2 text-xs text-muted">
            <div>SHA-256 <span className="break-all font-mono text-[10px]">{result.download.sha256}</span></div>
            <div>
              Enrollment code <span className="break-all font-mono text-[10px] text-ink">{result.enrollmentCode}</span>
            </div>
          </div>
          <p className="text-xs text-muted">Your account unlocks automatically once the new install completes its first integrity check.</p>
        </div>
      ) : token ? (
        <form onSubmit={redeem} className="mt-6 space-y-3">
          <label className="block">
            <span className="label">Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="glass-strong mt-1 h-11 w-full px-3.5 text-sm" required />
          </label>
          <label className="block">
            <span className="label">Authenticator code</span>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfa} onChange={(e) => setMfa(e.target.value.replace(/\D/g, ""))} className="glass-strong num mt-1 h-11 w-full px-3.5 text-sm tracking-[0.4em]" required />
          </label>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button className="btn-primary w-full" disabled={busy || mfa.length !== 6}>
            <Lock className="h-4 w-4" /> {busy ? "Verifying…" : "Verify and continue"}
          </button>
        </form>
      ) : (
        <form
          className="mt-6 space-y-3 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            await auth.recoveryResend(resendEmail).catch(() => undefined);
            setResent(true);
          }}
        >
          <p>The account owner has been emailed a one-time recovery link. Open it to verify your identity with your password and authenticator app.</p>
          {resent ? (
            <p className="font-medium text-ok">If that address owns the account, a new link is on its way.</p>
          ) : (
            <div className="flex gap-2">
              <input type="email" required placeholder="Account owner email" value={resendEmail} onChange={(e) => setResendEmail(e.target.value)} className="glass-strong h-11 min-w-0 flex-1 px-3.5 text-sm" />
              <button className="btn-ghost shrink-0">
                <Mail className="h-4 w-4" /> Resend
              </button>
            </div>
          )}
          <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => navigate("/")}>Back to home</button>
        </form>
      )}
    </AuthShell>
  );
}
