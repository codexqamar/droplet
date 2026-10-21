import { money } from "../lib/format";
import type { CreditPosition } from "../lib/types";

/**
 * Semicircle gauge: share of the credit limit in use. Handles accounts with no credit limit
 * (balance ÷ 0) explicitly instead of producing NaN/Infinity.
 */
function Gauge({ balance, limit }: { balance: number; limit: number }) {
  const noLimit = !(limit > 0);
  const ratio = noLimit ? (balance > 0 ? 1 : 0) : Math.max(balance, 0) / limit;
  const pct = Number.isFinite(ratio) ? ratio : 0;
  const arc = Math.min(pct, 1);
  const r = 70;
  const len = Math.PI * r;
  const tone = pct > 0.9 ? "rgb(var(--danger))" : pct > 0.7 ? "rgb(var(--warn))" : "rgb(var(--accent))";
  const headline = noLimit ? "—" : `${Math.round(pct * 100)}%`;
  const caption = noLimit ? (balance > 0 ? "no credit limit set" : "no credit limit") : pct > 1 ? "over limit" : "of limit used";
  return (
    <svg viewBox="0 0 180 100" className="w-full max-w-[240px]" role="img" aria-label={noLimit ? "No credit limit set" : `${Math.round(pct * 100)}% of credit limit used`}>
      <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke="rgb(var(--muted) / 0.18)" strokeWidth="14" strokeLinecap="round" />
      {arc > 0 && (
        <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke={tone} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${len * arc} ${len}`} />
      )}
      <text x="90" y="78" textAnchor="middle" className={noLimit ? "fill-muted num" : "fill-ink num"} style={{ fontSize: 24, fontWeight: 600 }}>
        {headline}
      </text>
      <text x="90" y="95" textAnchor="middle" className={pct > 1 ? "fill-danger" : "fill-muted"} style={{ fontSize: 9.5 }}>
        {caption}
      </text>
    </svg>
  );
}

export function CreditPanel({ credit, currency }: { credit: CreditPosition; currency: string }) {
  const available = Math.max(credit.limitMinor - credit.balanceMinor, 0);
  const agingTotal = credit.aging.reduce((s, a) => s + a.amountMinor, 0) || 1;
  const agingTone = ["bg-ok", "bg-accent", "bg-warn", "bg-danger"];

  return (
    <section className="glass flex h-full flex-col p-5 sm:p-6" aria-labelledby="credit-title">
      <div className="flex items-center justify-between">
        <h2 id="credit-title" className="section-title">Credit &amp; terms</h2>
        <span className="chip">Net {credit.termsDays}</span>
      </div>

      <div className="mt-3 flex justify-center">
        <Gauge balance={credit.balanceMinor} limit={credit.limitMinor} />
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
        {[
          ["Available", money(available, currency)],
          ["Balance", money(credit.balanceMinor, currency)],
          ["Limit", money(credit.limitMinor, currency)],
        ].map(([k, v]) => (
          <div key={k} className="glass-inset px-2 py-2.5">
            <dt className="label">{k}</dt>
            <dd className="num mt-0.5 text-sm font-semibold">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Aged balance</span>
          <span className="label">days overdue</span>
        </div>
        <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-muted/15">
          {credit.aging.map((a, i) => (
            <div key={a.label} className={agingTone[i]} style={{ width: `${(a.amountMinor / agingTotal) * 100}%` }} />
          ))}
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {credit.aging.map((a, i) => (
            <li key={a.label} className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted">
                <span className={`h-2 w-2 rounded-full ${agingTone[i]}`} /> {a.label}
              </span>
              <span className={`num font-medium ${i >= 2 && a.amountMinor > 0 ? "text-danger" : ""}`}>{money(a.amountMinor, currency)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
