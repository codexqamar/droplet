import { ClipboardPaste, CornerDownLeft, FileText, Minus, Plus, ShieldAlert, Trash2, Zap } from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { money } from "../lib/format";
import { nextBreak, unitPrice } from "../lib/pricing";
import type { CatalogueItem, PriceSource } from "../lib/types";

interface Line {
  sku: string;
  qty: number;
}

const sourceStyle: Record<PriceSource, string> = {
  ACCOUNT: "bg-accent/10 text-accent",
  TIER: "bg-ok/10 text-ok",
  LIST: "bg-muted/10 text-muted",
};
const sourceLabel: Record<PriceSource, string> = { ACCOUNT: "Contract", TIER: "Tier", LIST: "List" };

function StockDot({ stock, qty }: { stock: number; qty: number }) {
  const [tone, text] =
    stock === 0 ? ["bg-danger", "Backorder"] : stock < qty ? ["bg-warn", `${stock} available`] : stock < 100 ? ["bg-warn", `${stock} in stock`] : ["bg-ok", "In stock"];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {text}
    </span>
  );
}

interface Props {
  catalogue: CatalogueItem[];
  currency: string;
  availableCreditMinor: number;
  /** Lines pushed in from elsewhere (e.g. Reorder); a new nonce merges them in. */
  inject?: { nonce: number; lines: Line[] } | null;
  onPlace: (lines: Line[], poNumber: string, mode: "submit" | "draft") => Promise<string>;
  onQuote: (lines: Line[]) => Promise<string>;
  allowDraft?: boolean;
  /** Hide "Request quote" (staff ordering for a customer price quotes in the Quotes page). */
  allowQuote?: boolean;
  /** Placeholder for the PO field; staff enter the customer's reference. */
  poPlaceholder?: string;
}

export const QuickOrder = forwardRef<HTMLInputElement, Props>(
  function QuickOrder({ catalogue, currency, availableCreditMinor, inject, onPlace, onQuote, allowDraft = true, allowQuote = true, poPlaceholder = "Your PO reference (optional)" }, skuRef) {
    const bySku = useMemo(() => new Map(catalogue.map((c) => [c.sku, c])), [catalogue]);
    const [lines, setLines] = useState<Line[]>([]);
    const [po, setPo] = useState("");
    const [busy, setBusy] = useState<null | "submit" | "draft" | "quote">(null);
    const [sku, setSku] = useState("");
    const [qty, setQty] = useState("1");
    const [active, setActive] = useState(0);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pasteMode, setPasteMode] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const [placed, setPlaced] = useState<string | null>(null);
    const qtyRef = useRef<HTMLInputElement>(null);

    // Apply each injected batch exactly once (the catalogue reloads after every order).
    const appliedNonce = useRef<number | null>(null);
    useEffect(() => {
      if (!inject || appliedNonce.current === inject.nonce) return;
      appliedNonce.current = inject.nonce;
      setLines((prev) => {
        const next = [...prev];
        for (const l of inject.lines) {
          if (!bySku.has(l.sku)) continue;
          const i = next.findIndex((x) => x.sku === l.sku);
          if (i === -1) next.push({ ...l });
          else next[i] = { sku: l.sku, qty: next[i]!.qty + l.qty };
        }
        return next;
      });
      setPlaced(null);
    }, [inject, bySku]);

    const run = async (kind: "submit" | "draft" | "quote") => {
      setBusy(kind);
      setError(null);
      try {
        const snapshot = lines.map((l) => ({ sku: l.sku, qty: l.qty }));
        const msg = kind === "quote" ? await onQuote(snapshot) : await onPlace(snapshot, po.trim(), kind);
        setPlaced(msg);
        setLines([]);
        setPo("");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    };

    const q = sku.trim().toUpperCase();
    const suggestions = useMemo(
      () =>
        q.length === 0
          ? []
          : catalogue.filter((c) => c.sku.startsWith(q) || c.name.toUpperCase().includes(q)).slice(0, 6),
      [catalogue, q],
    );

    const addLine = (code: string, n: number) => {
      setLines((prev) => {
        const i = prev.findIndex((l) => l.sku === code);
        if (i === -1) return [...prev, { sku: code, qty: n }];
        return prev.map((l, j) => (j === i ? { ...l, qty: l.qty + n } : l));
      });
      setPlaced(null);
    };

    const choose = (item: CatalogueItem) => {
      setSku(item.sku);
      setOpen(false);
      setError(null);
      qtyRef.current?.focus();
      qtyRef.current?.select();
    };

    const commit = () => {
      const item = bySku.get(q) ?? (suggestions.length === 1 ? suggestions[0] : undefined);
      const n = Number.parseInt(qty, 10);
      if (!item) return setError(`No catalogue item matches “${sku.trim()}”`);
      if (!Number.isFinite(n) || n <= 0) return setError("Quantity must be a whole number above zero");
      addLine(item.sku, n);
      setSku("");
      setQty("1");
      setError(null);
      (skuRef as React.RefObject<HTMLInputElement>).current?.focus();
    };

    const onSkuKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setActive((a) => Math.min(a + 1, suggestions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const exact = bySku.get(q);
        const pick = exact ?? suggestions[active];
        if (pick) choose(pick);
        else setError(`No catalogue item matches “${sku.trim()}”`);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };

    const applyPaste = () => {
      const missing: string[] = [];
      for (const raw of pasteText.split(/\r?\n/)) {
        const m = raw.trim().match(/^([A-Za-z0-9-]+)[\s,;\t]+(\d+)/);
        if (!m) continue;
        const code = m[1]!.toUpperCase();
        if (bySku.has(code)) addLine(code, Number(m[2]));
        else missing.push(code);
      }
      setError(missing.length ? `Not in your catalogue: ${missing.join(", ")}` : null);
      setPasteText("");
      setPasteMode(false);
    };

    const priced = lines.filter((l) => bySku.has(l.sku)).map((l) => {
      const item = bySku.get(l.sku)!;
      const p = unitPrice(item, l.qty);
      return { ...l, item, ...p, lineMinor: p.unitMinor * l.qty, listLineMinor: item.listMinor * l.qty };
    });
    const subtotal = priced.reduce((s, l) => s + l.lineMinor, 0);
    const savings = priced.reduce((s, l) => s + l.listLineMinor - l.lineMinor, 0);
    const overCredit = subtotal > availableCreditMinor;

    return (
      <section className="glass flex h-full flex-col p-5 sm:p-6" aria-labelledby="qo-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="qo-title" className="section-title flex items-center gap-2">
              <Zap className="h-4 w-4 text-accent" /> Quick order
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Type a SKU, <kbd className="font-mono">Enter</kbd>, quantity, <kbd className="font-mono">Enter</kbd>. Prices shown are your negotiated rates.
            </p>
          </div>
          <button className="btn-ghost py-2 text-xs" onClick={() => setPasteMode((v) => !v)}>
            <ClipboardPaste className="h-4 w-4" /> {pasteMode ? "Single entry" : "Paste lines"}
          </button>
        </div>

        {pasteMode ? (
          <div className="mt-4 space-y-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              placeholder={"One line per item, e.g.\nBV-1015, 24\nPF-T22\t60"}
              className="glass-strong w-full resize-y px-3 py-2.5 font-mono text-sm placeholder:text-muted/70"
            />
            <div className="flex justify-end">
              <button className="btn-primary py-2 text-xs" onClick={applyPaste} disabled={!pasteText.trim()}>
                Add to order
              </button>
            </div>
          </div>
        ) : (
          <div className="relative mt-4 grid grid-cols-[1fr_96px_auto] gap-2">
            <input
              ref={skuRef}
              value={sku}
              onChange={(e) => {
                setSku(e.target.value);
                setOpen(true);
                setActive(0);
                setError(null);
              }}
              onKeyDown={onSkuKey}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              placeholder="SKU or description"
              aria-label="SKU"
              aria-autocomplete="list"
              aria-expanded={open && suggestions.length > 0}
              className="glass-strong h-11 w-full px-3.5 font-mono text-sm uppercase placeholder:font-sans placeholder:normal-case placeholder:text-muted/70"
            />
            <input
              ref={qtyRef}
              value={qty}
              inputMode="numeric"
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              aria-label="Quantity"
              className="glass-strong num h-11 w-full px-3 text-right text-sm"
            />
            <button className="btn-primary h-11 px-3.5" onClick={commit} aria-label="Add line">
              <CornerDownLeft className="h-4 w-4" />
            </button>

            {open && suggestions.length > 0 && (
              <ul role="listbox" className="popover absolute left-0 right-0 top-12 z-20 overflow-hidden p-1 shadow-dock sm:right-[136px]">
                {suggestions.map((s, i) => {
                  const p = unitPrice(s, 1);
                  return (
                    <li
                      key={s.sku}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(s);
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${i === active ? "bg-accent/10" : ""}`}
                    >
                      <span className="w-24 shrink-0 font-mono text-xs font-medium">{s.sku}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                      <StockDot stock={s.stock} qty={1} />
                      <span className="num w-20 text-right text-sm font-semibold">{money(p.unitMinor, currency)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-xs font-medium text-danger">{error}</p>}

        <div className="mt-4 -mx-1 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="px-1 pb-2 font-medium">Item</th>
                <th className="px-1 pb-2 text-center font-medium">Qty</th>
                <th className="px-1 pb-2 text-right font-medium">Unit</th>
                <th className="px-1 pb-2 text-right font-medium">Line</th>
                <th className="w-8 pb-2" />
              </tr>
            </thead>
            <tbody>
              {priced.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-muted">
                    No lines yet. Press <kbd className="font-mono">/</kbd> to start typing a SKU.
                  </td>
                </tr>
              )}
              {priced.map((l) => {
                const nb = nextBreak(l.item, l.qty);
                return (
                  <tr key={l.sku} className="border-t border-line/60 align-top dark:border-line/[0.07]">
                    <td className="px-1 py-3">
                      <div className="font-mono text-xs font-semibold">{l.sku}</div>
                      <div className="text-[13px]">{l.item.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StockDot stock={l.item.stock} qty={l.qty} />
                        {nb && (
                          <span className="text-[11px] text-accent">
                            {nb.minQty - l.qty} more for {money(nb.unitMinor, currency)}/{l.item.uom}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-1 py-3">
                      <div className="mx-auto flex w-[118px] items-center rounded-xl border border-line/70 bg-surface/70 dark:border-line/[0.07]">
                        <button className="grid h-8 w-8 place-items-center text-muted hover:text-ink" aria-label={`Decrease ${l.sku}`}
                          onClick={() => setLines((p) => p.map((x) => (x.sku === l.sku ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))}>
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <input
                          value={l.qty}
                          inputMode="numeric"
                          aria-label={`Quantity for ${l.sku}`}
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value.replace(/\D/g, "") || "0", 10);
                            setLines((p) => p.map((x) => (x.sku === l.sku ? { ...x, qty: Math.max(1, n) } : x)));
                          }}
                          className="num w-full bg-transparent text-center text-sm font-medium outline-none"
                        />
                        <button className="grid h-8 w-8 place-items-center text-muted hover:text-ink" aria-label={`Increase ${l.sku}`}
                          onClick={() => setLines((p) => p.map((x) => (x.sku === l.sku ? { ...x, qty: x.qty + 1 } : x)))}>
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-1 py-3 text-right">
                      <div className="num font-medium">{money(l.unitMinor, currency)}</div>
                      <div className="mt-1 flex items-center justify-end gap-1.5">
                        {l.unitMinor < l.item.listMinor && (
                          <span className="num text-[11px] text-muted line-through">{money(l.item.listMinor, currency)}</span>
                        )}
                        <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${sourceStyle[l.source]}`}>{sourceLabel[l.source]}</span>
                      </div>
                    </td>
                    <td className="num px-1 py-3 text-right font-semibold">{money(l.lineMinor, currency)}</td>
                    <td className="py-3 text-right">
                      <button className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Remove ${l.sku}`}
                        onClick={() => setLines((p) => p.filter((x) => x.sku !== l.sku))}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-auto border-t border-line/60 pt-4 dark:border-line/[0.07]">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1 text-xs text-muted">
              <div>
                {priced.length} line{priced.length === 1 ? "" : "s"} · saving <span className="num font-semibold text-ok">{money(savings, currency)}</span> against list
              </div>
              {overCredit ? (
                <div className="flex items-center gap-1.5 font-medium text-warn">
                  <ShieldAlert className="h-3.5 w-3.5" /> Exceeds available credit, so it will go to your account manager for approval
                </div>
              ) : (
                <div>Within available credit of {money(availableCreditMinor, currency)}</div>
              )}
              {placed && <div className="font-medium text-ok">{placed}</div>}
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="label">Subtotal ex. VAT</div>
                <div className="num text-2xl font-semibold tracking-tight">{money(subtotal, currency)}</div>
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <input
              value={po}
              onChange={(e) => setPo(e.target.value)}
              maxLength={64}
              placeholder={poPlaceholder}
              aria-label="Purchase order reference"
              className="glass-strong h-10 min-w-0 flex-1 px-3 text-sm sm:max-w-[240px]"
            />
            {allowQuote && (
              <button className="btn-ghost" disabled={!priced.length || !!busy} onClick={() => void run("quote")}>
                <FileText className="h-4 w-4" /> {busy === "quote" ? "Sending…" : "Request quote"}
              </button>
            )}
            {allowDraft && (
              <button className="btn-ghost" disabled={!priced.length || !!busy} onClick={() => void run("draft")}>
                {busy === "draft" ? "Saving…" : "Save draft"}
              </button>
            )}
            <button className="btn-primary" disabled={!priced.length || !!busy} onClick={() => void run("submit")}>
              {busy === "submit" ? "Placing…" : overCredit ? "Submit for approval" : "Place order"}
            </button>
          </div>
        </div>
      </section>
    );
  },
);
