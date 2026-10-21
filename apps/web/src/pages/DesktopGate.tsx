import { ArrowLeft, KeyRound, Laptop, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, desktop } from "../lib/api";
import { AuthShell } from "./AuthPages";

const errors: Record<string, string> = {
  ENROLLMENT_CODE_INVALID: "That code is invalid or has expired. Get a fresh one from the web portal.",
  BUILD_NOT_TRUSTED: "This installer isn't the build issued to your account. Download it again from the web portal.",
  MACHINE_ALREADY_ENROLLED: "This computer is already registered to your account.",
  OFFLINE: "DROPLET is unavailable. Try again shortly.",
};

/**
 * First-run gate on desktop: the app does nothing until this install is enrolled with a code
 * issued by the authenticated web portal. Enrollment creates the device key and certificate.
 */
export function DesktopGate({ onEnrolled, notice, addAccount = false, onCancel, onStaff }: { onEnrolled: () => void; notice?: string | null; addAccount?: boolean; onCancel?: () => void; onStaff?: () => void }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (addAccount) await desktop.addAccount(code.trim(), label.trim());
      else await desktop.enroll(code.trim(), label.trim());
      onEnrolled();
    } catch (err) {
      const a = err as ApiError;
      const key = Object.keys(errors).find((k) => a.code.includes(k) || a.message.includes(k));
      setError(key ? errors[key]! : a.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell wide>
      {onCancel && <button type="button" className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink" onClick={onCancel}><ArrowLeft className="h-3.5 w-3.5" /> Back to portal</button>}
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent text-onaccent">
          <Laptop className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold">{addAccount ? "Add a new trade account" : "Connect this computer"}</h1>
          <p className="text-sm text-muted">{addAccount ? "Keep this account separate and switch between portals at any time." : "Link the desktop app to your trade account."}</p>
        </div>
      </div>
      {notice && <p className="mt-4 rounded-xl bg-warn/10 px-3 py-2 text-xs font-medium text-warn">{notice}</p>}
      <ol className="mt-5 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Sign in to the DROPLET web portal.</li>
        <li>In <span className="font-medium text-ink">Desktop app</span>, select <span className="font-medium text-ink">Get signed installer</span>.</li>
        <li>Copy the enrollment code shown there and paste it below.</li>
      </ol>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className="label">Enrollment code</span>
          <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} required autoFocus spellCheck={false}
            className="glass-strong mt-1 w-full resize-none px-3.5 py-2.5 font-mono text-xs" placeholder="enroll.eyJ…" />
        </label>
        <label className="block">
          <span className="label">Name for this computer</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} placeholder="e.g. Trade counter PC" className="glass-strong mt-1 h-11 w-full px-3.5 text-sm" />
        </label>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || !code.trim() || !label.trim()}>
          <KeyRound className="h-4 w-4" /> {busy ? "Connecting and syncing…" : "Connect"}
        </button>
      </form>
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
        A private key is created for this computer and protected by Windows. It never leaves the machine.
      </p>
      {onStaff && (
        <p className="mt-4 border-t border-line/60 pt-4 text-xs text-muted dark:border-line/[0.07]">
          Staff member?{" "}
          <button type="button" className="font-medium text-accent hover:underline" onClick={onStaff}>Sign in to the admin portal</button>
        </p>
      )}
    </AuthShell>
  );
}
