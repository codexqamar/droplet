import { Check, CheckCircle2, Copy, Download, KeyRound, Laptop, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { ApiError, auth } from "../lib/api";
import { relative } from "../lib/format";
import type { DeviceSummary } from "../lib/types";

interface Grant {
  url: string;
  sha256: string;
  version: string;
  enrollmentCode: string;
  expiresInSec: number;
}

const statusUi = {
  TRUSTED: { icon: ShieldCheck, cls: "text-ok", label: "Verified" },
  PENDING_ENROLLMENT: { icon: KeyRound, cls: "text-warn", label: "Awaiting first check-in" },
  QUARANTINED: { icon: ShieldX, cls: "text-danger", label: "Quarantined" },
  RETIRED: { icon: ShieldX, cls: "text-muted", label: "Retired" },
} as const;

const grantErrors: Record<string, string> = {
  MFA_REQUIRED: "Two-step verification is required before downloading the desktop app.",
  NO_RELEASE: "No desktop build has been published yet.",
};

/**
 * Web: the only route to the installer. POST /v1/desktop/download-grants returns a single-use,
 * short-lived signed URL plus an enrollment code; nothing is publicly downloadable.
 * Desktop: shows this install's verification and sync state instead.
 */
export function DesktopAccess({ devices, thisDevice }: { devices: DeviceSummary[]; thisDevice?: { id: string | null; version: string } }) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <section className="glass flex h-full flex-col p-5 sm:p-6" aria-labelledby="desktop-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="desktop-title" className="section-title">{thisDevice ? "This computer" : "Desktop app"}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {thisDevice ? "Catalogue and prices are served locally; orders send on sync." : "Offline catalogue and instant SKU entry, synced on demand."}
          </p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-onaccent">
          <Laptop className="h-5 w-5" />
        </span>
      </div>

      <ul className="mt-4 space-y-2">
        {devices.length === 0 && <li className="text-xs text-muted">No computers connected yet.</li>}
        {devices.map((d) => {
          const s = statusUi[d.status];
          const mine = thisDevice?.id === d.id;
          return (
            <li key={d.id} className={`glass-inset flex items-center gap-3 px-3 py-2.5 ${mine ? "ring-1 ring-accent/40" : ""}`}>
              <s.icon className={`h-4 w-4 shrink-0 ${s.cls}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {d.label} {mine && <span className="text-[11px] font-normal text-accent">· this computer</span>}
                </div>
                <div className="text-[11px] text-muted">
                  v{d.version} · {s.label}
                  {d.lastAttestedAt && ` ${relative(d.lastAttestedAt)}`}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {!thisDevice && (
        <div className="mt-auto pt-4">
          {grant ? (
            <div className="space-y-2 text-xs">
              <a href={grant.url} className="btn-primary w-full">
                <Download className="h-4 w-4" /> Download v{grant.version}
              </a>
              <div className="glass-inset space-y-2 px-3 py-2.5">
                <div className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> Link works once, for {Math.round(grant.expiresInSec / 60)} minutes
                </div>
                <div>
                  <div className="text-muted">Enrollment code (paste on first launch)</div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg bg-muted/10 px-2 py-1 font-mono text-[10px]">{grant.enrollmentCode}</code>
                    <button
                      className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
                      onClick={async () => {
                        await navigator.clipboard.writeText(grant.enrollmentCode);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
                <div className="text-muted">
                  SHA-256 <span className="break-all font-mono text-[10px]">{grant.sha256}</span>
                </div>
              </div>
            </div>
          ) : (
            <button
              className="btn-primary w-full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  setGrant(await auth.downloadGrant(navigator.userAgent.includes("Mac") ? "macos-arm64" : "win-x64"));
                } catch (e) {
                  const a = e as ApiError;
                  setErr(grantErrors[a.code] ?? a.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Download className="h-4 w-4" /> {busy ? "Preparing secure link…" : "Get signed installer"}
            </button>
          )}
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Signed build. Each launch verifies its own files; if any file has been modified, the app stops and the account is locked to protect it.
          </p>
        </div>
      )}
      {thisDevice && (
        <p className="mt-auto pt-4 text-[11px] leading-relaxed text-muted">
          Version {thisDevice.version}. Program files are verified at launch and every 15 minutes.
        </p>
      )}
    </section>
  );
}
