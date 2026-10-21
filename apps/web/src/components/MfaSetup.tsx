import QRCode from "qrcode";
import { KeyRound, ShieldCheck, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { auth } from "../lib/api";

/**
 * Authenticator enrollment. Required before the desktop app can be issued, because recovering
 * from a tamper lock needs a TOTP code.
 */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setOpen(true);
    setError(null);
    const { otpauthUri } = await auth.mfaSetup();
    setSecret(new URL(otpauthUri).searchParams.get("secret") ?? "");
    setQr(await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 }));
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.mfaConfirm(code);
      setOpen(false);
      onDone();
    } catch {
      setError("That code didn't match. Check the time on your phone and try the next code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="glass flex flex-wrap items-center gap-4 p-4 sm:px-6">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Turn on two-step verification</div>
          <div className="text-xs text-muted">Needed to install the desktop app and to recover your account if it is ever locked.</div>
        </div>
        <button className="btn-primary py-2" onClick={() => void start()}>Set up authenticator</button>
      </div>

      {open && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4" role="dialog" aria-modal="true" aria-labelledby="mfa-title">
          <form onSubmit={confirm} className="glass-float w-full max-w-sm p-6">
            <div className="flex items-start justify-between">
              <h2 id="mfa-title" className="section-title flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-accent" /> Authenticator app
              </h2>
              <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-ink" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">Scan with Google Authenticator, Microsoft Authenticator, 1Password or similar.</p>
            <div className="mt-4 grid place-items-center">
              {qr ? <img src={qr} alt="Authenticator QR code" className="h-48 w-48 rounded-xl bg-white p-2" /> : <div className="h-48 w-48 animate-pulse rounded-xl bg-muted/15" />}
            </div>
            {secret && (
              <p className="mt-3 text-center text-[11px] text-muted">
                Or enter key <span className="select-all break-all font-mono text-ink">{secret}</span>
              </p>
            )}
            <label className="mt-4 block">
              <span className="label">6-digit code</span>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus className="field num mt-1 h-11 w-full px-3.5 text-center text-sm tracking-[0.4em]" />
            </label>
            {error && <p className="mt-2 text-xs font-medium text-danger">{error}</p>}
            <button className="btn-primary mt-4 w-full" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Confirm"}</button>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}
