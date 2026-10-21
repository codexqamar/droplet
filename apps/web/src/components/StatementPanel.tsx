import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { daysUntil, money, shortDate } from "../lib/format";
import type { LedgerLine } from "../lib/types";

const kindLabel = { INVOICE: "Invoice", CREDIT_NOTE: "Credit note", PAYMENT: "Payment received", ADJUSTMENT: "Adjustment" } as const;

export function StatementPanel({ ledger, currency }: { ledger: LedgerLine[]; currency: string }) {
  return (
    <section id="statements" className="glass scroll-mt-4 p-5 sm:p-6" aria-labelledby="stmt-title">
      <div className="flex items-center justify-between">
        <h2 id="stmt-title" className="section-title">Statement</h2>
        <span className="text-xs text-muted">Recent activity</span>
      </div>
      {ledger.length === 0 && <p className="py-6 text-center text-sm text-muted">No statement activity yet.</p>}
      <ul className="mt-3 divide-y divide-line/60 dark:divide-line/[0.07]">
        {ledger.map((l) => {
          const credit = l.amountMinor < 0;
          const due = l.dueAt ? daysUntil(l.dueAt) : null;
          return (
            <li key={l.ref} className="flex items-center gap-3 py-3">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${credit ? "bg-ok/10 text-ok" : "bg-accent/10 text-accent"}`}>
                {credit ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {kindLabel[l.kind]} <span className="font-mono text-xs text-muted">{l.ref}</span>
                </div>
                <div className="text-xs text-muted">
                  Posted {shortDate(l.postedAt)}
                  {due !== null && (
                    <span className={due < 0 ? "font-medium text-danger" : ""}>
                      {" · "}
                      {due < 0 ? `${-due} days overdue` : `due in ${due} days`}
                    </span>
                  )}
                </div>
              </div>
              <span className={`num text-sm font-semibold ${credit ? "text-ok" : ""}`}>
                {credit ? "−" : ""}
                {money(Math.abs(l.amountMinor), currency)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
