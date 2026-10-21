import { FileText } from "lucide-react";
import { useState } from "react";
import { daysUntil, money } from "../lib/format";
import type { QuoteSummary } from "../lib/types";

const status = {
  OFFERED: { label: "Offer ready", cls: "bg-ok/10 text-ok" },
  IN_REVIEW: { label: "In review", cls: "bg-accent/10 text-accent" },
  REQUESTED: { label: "Requested", cls: "bg-muted/10 text-muted" },
} as const;

export function QuotesPanel({ quotes, currency = "GBP", onAccept }: { quotes: QuoteSummary[]; currency?: string; onAccept?: (number: string) => Promise<string> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <section id="quotes" className="glass scroll-mt-4 p-5 sm:p-6" aria-labelledby="quotes-title">
      <div className="flex items-center justify-between">
        <h2 id="quotes-title" className="section-title">Quotes</h2>
        <span className="text-xs text-muted">Open</span>
      </div>
      {message && <p className={`mt-2 text-xs font-medium ${message.ok ? "text-ok" : "text-danger"}`}>{message.text}</p>}
      {quotes.length === 0 && <p className="py-6 text-center text-sm text-muted">No open quotes. Use “Request quote” in Quick order.</p>}
      <ul className="mt-3 space-y-2">
        {quotes.map((q) => (
          <li key={q.number} className="glass-inset flex items-center gap-3 px-3 py-2.5">
            <FileText className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">{q.number}</span>
                <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${status[q.status].cls}`}>{status[q.status].label}</span>
              </div>
              <div className="text-[11px] text-muted">
                {q.lines} {q.lines === 1 ? "line" : "lines"} · {q.handler}
                {q.validUntil && ` · valid ${daysUntil(q.validUntil)} more days`}
              </div>
            </div>
            {q.status === "OFFERED" && q.offeredTotalMinor != null && <span className="num text-sm font-semibold">{money(q.offeredTotalMinor, currency)}</span>}
            {q.status === "OFFERED" && onAccept && (
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(q.number);
                  setMessage(null);
                  try {
                    setMessage({ ok: true, text: await onAccept(q.number) });
                  } catch (e) {
                    setMessage({ ok: false, text: (e as Error).message });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === q.number ? "Accepting…" : "Accept"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
