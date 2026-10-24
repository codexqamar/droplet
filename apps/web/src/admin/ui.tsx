import { Check, Copy, Search, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ApiError } from "../lib/api";

/** Shared building blocks for the admin portal; same glass language as the trade portal. */

export function PageHeading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="portal-heading">
      <div className="min-w-0">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

export function Panel({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="section-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const tones: Record<string, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/10 text-danger",
  accent: "bg-accent/10 text-accent",
  muted: "bg-muted/10 text-muted",
};
const statusTone: Record<string, [string, keyof typeof tones]> = {
  PENDING_APPROVAL: ["Pending approval", "warn"],
  AWAITING_BUYER_APPROVAL: ["With customer's approver", "muted"],
  APPROVED: ["Approved", "ok"],
  REJECTED: ["Rejected", "danger"],
  SUSPENDED: ["Suspended", "danger"],
  DRAFT: ["Draft", "muted"],
  SUBMITTED: ["Submitted", "accent"],
  CONFIRMED: ["Confirmed", "accent"],
  PART_SHIPPED: ["Part shipped", "ok"],
  SHIPPED: ["Shipped", "ok"],
  INVOICED: ["Invoiced", "muted"],
  CANCELLED: ["Cancelled", "danger"],
  REQUESTED: ["Requested", "warn"],
  IN_REVIEW: ["In review", "accent"],
  OFFERED: ["Offer sent", "ok"],
  ACCEPTED: ["Accepted", "ok"],
  DECLINED: ["Declined", "danger"],
  EXPIRED: ["Expired", "muted"],
  TRUSTED: ["Verified", "ok"],
  PENDING_ENROLLMENT: ["Not checked in", "warn"],
  QUARANTINED: ["Quarantined", "danger"],
  RETIRED: ["Retired", "muted"],
  ACTIVE: ["Active", "ok"],
  LOCKED_TAMPER: ["Locked", "danger"],
  RECOVERY_PENDING: ["Recovery pending", "warn"],
  RECOVERY_VERIFIED: ["Recovery verified", "warn"],
  AWAITING_CLEAN_INSTALL: ["Awaiting clean install", "warn"],
  ADMIN: ["Administrator", "accent"],
  SALES_REP: ["Account manager", "muted"],
  TRADE_CUSTOMER: ["Trade buyer", "muted"],
};

export function Badge({ status, label, tone }: { status?: string; label?: string; tone?: keyof typeof tones }) {
  const [text, t] = status ? statusTone[status] ?? [status.replace(/_/g, " ").toLowerCase(), "muted"] : [label ?? "", tone ?? "muted"];
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[t]}`}>{text}</span>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; count?: number }>; onChange: (v: T) => void }) {
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-2xl border border-line/60 bg-surface/40 p-1 dark:border-line/[0.08]" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition ${o.value === value ? "bg-surface text-ink shadow-glass" : "text-muted hover:text-ink"}`}
        >
          {o.label}
          {o.count !== undefined && o.count > 0 && <span className="num rounded-full bg-accent/15 px-1.5 text-[10px] text-accent">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="catalogue-search">
      <Search className="h-4 w-4 shrink-0" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered at the page root: inside a glass (backdrop-filter) panel, `position: fixed` is
  // measured from that panel instead of the window, which left an uncovered strip at the top.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/25 p-4" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`glass-float my-8 w-full p-5 sm:p-6 ${wide ? "max-w-4xl" : "max-w-lg"}`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls = "field h-10 w-full px-3 text-sm";

export function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="empty-state">
      <Icon />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

export function CopyLink({ url, note }: { url: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-2xl border border-ok/30 bg-ok/10 p-3 text-xs">
      <p className="font-medium text-ink">{note}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-surface/70 px-2 py-1.5 font-mono text-[11px]">{url}</code>
        <button
          className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          aria-label="Copy link"
          title="Copy link"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="text-xs font-medium text-danger">{error}</p> : null;
}

const friendly: Record<string, string> = {
  EMAIL_IN_USE: "That email already has an account.",
  SKU_EXISTS: "A product with that SKU already exists.",
  UNKNOWN_SKU: "No product with that SKU.",
  INVALID_TRANSITION: "That status change isn't allowed from the order's current state.",
  ADMIN_ONLY: "Only administrators can do that.",
  LAST_ADMIN: "You can't deactivate the last administrator.",
  CANNOT_CHANGE_SELF: "You can't change your own access.",
  TIER_EXISTS: "A tier with that name already exists.",
  REP_NOT_FOUND: "Choose an active account manager.",
  BARCODE_IN_USE: "Another product already uses that barcode.",
  WAREHOUSE_EXISTS: "A branch with that code already exists.",
  MAIL_FAILED: "The email could not be sent. Check SMTP_URL and MAIL_FROM.",
  BAD_REQUEST: "Check the highlighted values and try again.",
};
export const errorMessage = (e: unknown) => {
  const a = e as ApiError;
  return friendly[a.code] ?? a.message ?? "Something went wrong.";
};

/** Load-on-mount with reload; keeps previous data while refreshing. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Runs an action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (key: string, fn: () => Promise<unknown>): Promise<any> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}
