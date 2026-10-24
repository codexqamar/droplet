import { Boxes, Download, FileUp, Plus, Tags, Warehouse as WarehouseIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { admin, parseMoney, toMoneyInput, type ImportRow, type Product, type Tier, type Warehouse } from "../lib/admin";
import { money } from "../lib/format";
import { Badge, EmptyState, ErrorText, Field, inputCls, Modal, PageHeading, Panel, SearchBox, useAction, useLoad } from "./ui";

export function CataloguePage({ isAdmin, currency }: { isAdmin: boolean; currency: string }) {
  const data = useLoad(() => admin.products(), []);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [tierName, setTierName] = useState("");
  const act = useAction();
  const warehouses = data.data?.warehouses ?? [];
  const activeWh = warehouses.filter((w) => w.active);
  const products = useMemo(() => {
    const t = q.trim().toUpperCase();
    return (data.data?.products ?? []).filter((p) => !t || p.sku.includes(t) || p.name.toUpperCase().includes(t) || p.barcode === t);
  }, [data.data, q]);

  return (
    <div className="space-y-5">
      <PageHeading
        title="Catalogue & pricing"
        description="Products, stock by branch, lead times and list prices, plus price tiers with quantity breaks. Buyers see stock changes within seconds; desktop apps on their next sync."
        action={
          isAdmin && (
            <>
              <a className="btn-ghost" href={admin.exportUrl("products")} download><Download className="h-4 w-4" /> Export</a>
              <button className="btn-ghost" onClick={() => setImporting(true)}><FileUp className="h-4 w-4" /> Import CSV</button>
              <button className="btn-primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add product</button>
            </>
          )
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Branches & warehouses" action={<WarehouseIcon className="h-4 w-4 text-muted" />}>
          <BranchManager warehouses={warehouses} isAdmin={isAdmin} onChanged={() => void data.reload()} />
        </Panel>
        <Panel title="Price tiers" action={<Tags className="h-4 w-4 text-muted" />}>
          <div className="flex flex-wrap items-center gap-2">
            {(data.data?.tiers ?? []).map((t) => <span key={t.id} className="chip">{t.name} · {t.accounts} account{t.accounts === 1 ? "" : "s"}</span>)}
            {data.data?.tiers.length === 0 && <span className="text-sm text-muted">No tiers yet. Accounts without a tier pay list price unless they have contract prices.</span>}
          </div>
          {isAdmin && (
            <form className="mt-3 flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              void act.run("tier", () => admin.createTier(tierName.trim())).then((ok) => ok && (setTierName(""), data.reload()));
            }}>
              <input className={`${inputCls} max-w-xs`} placeholder="New tier, e.g. Gold" required minLength={2} value={tierName} onChange={(e) => setTierName(e.target.value)} />
              <button className="btn-ghost shrink-0" disabled={!!act.busy}>Add tier</button>
            </form>
          )}
          <ErrorText error={act.error} />
        </Panel>
      </div>

      <Panel>
        <div className="mb-3"><SearchBox value={q} onChange={setQ} placeholder="Search SKU, name or barcode" /></div>
        {!data.loading && products.length === 0 && <EmptyState icon={Boxes} title={q ? "No matches" : "No products yet"} body={q ? "Try another search." : "Add your first product, or import your catalogue from a CSV."} />}
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            {products.length > 0 && (
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-1 pb-2 font-medium">Product</th>
                  <th className="px-1 pb-2 font-medium">Unit</th>
                  <th className="px-1 pb-2 text-right font-medium">Stock</th>
                  <th className="px-1 pb-2 font-medium">By branch</th>
                  <th className="px-1 pb-2 text-right font-medium">Lead time</th>
                  <th className="px-1 pb-2 text-right font-medium">List price</th>
                  <th className="px-1 pb-2 font-medium">Status</th>
                </tr>
              </thead>
            )}
            <tbody>
              {products.map((p) => (
                <tr key={p.id} onClick={() => isAdmin && setEditing(p)} className={`border-t border-line/60 align-top dark:border-line/[0.07] ${isAdmin ? "cursor-pointer hover:bg-surface/40" : ""}`}>
                  <td className="px-1 py-3"><div className="font-mono text-xs font-semibold">{p.sku}</div><div className="max-w-[22rem] truncate">{p.name}</div>{p.barcode && <div className="font-mono text-[10px] text-muted">{p.barcode}</div>}</td>
                  <td className="px-1 py-3 text-muted">{p.uom}{p.packSize > 1 ? ` × ${p.packSize}` : ""}</td>
                  <td className={`num px-1 py-3 text-right font-semibold ${p.stock === 0 ? "text-danger" : ""}`}>{p.stock}</td>
                  <td className="px-1 py-3">
                    <div className="flex flex-wrap gap-1">
                      {activeWh.map((w) => {
                        const qty = p.levels.find((l) => l.warehouseId === w.id)?.qty ?? 0;
                        return <span key={w.id} title={w.name} className={`rounded-md px-1.5 py-px text-[10px] font-medium ${qty > 0 ? "bg-ok/10 text-ok" : "bg-muted/10 text-muted"}`}>{w.code} {qty}</span>;
                      })}
                    </div>
                  </td>
                  <td className="num px-1 py-3 text-right text-muted">{p.leadTimeDays ? `${p.leadTimeDays} d` : "—"}</td>
                  <td className="num px-1 py-3 text-right font-semibold">{money(p.listMinor, currency)}</td>
                  <td className="px-1 py-3">{p.active ? <Badge label="Active" tone="ok" /> : <Badge label="Hidden" tone="muted" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {editing && <ProductEditor product={editing === "new" ? null : editing} tiers={data.data?.tiers ?? []} warehouses={activeWh} currency={currency} onClose={() => setEditing(null)} onSaved={() => void data.reload()} />}
      {importing && <ImportDialog warehouses={warehouses} onClose={() => setImporting(false)} onDone={() => void data.reload()} />}
    </div>
  );
}

function BranchManager({ warehouses, isAdmin, onChanged }: { warehouses: Warehouse[]; isAdmin: boolean; onChanged: () => void }) {
  const act = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  return (
    <>
      <ul className="divide-y divide-line/60 text-sm dark:divide-line/[0.07]">
        {warehouses.map((w) => (
          <li key={w.id} className="flex items-center gap-3 py-2">
            <span className="w-14 shrink-0 font-mono text-xs font-semibold">{w.code}</span>
            <span className={`min-w-0 flex-1 truncate ${w.active ? "" : "text-muted line-through"}`}>{w.name}</span>
            {isAdmin && (
              <button className="text-xs font-medium text-accent" disabled={!!act.busy} onClick={() => void act.run(w.id, () => admin.updateWarehouse(w.id, { active: !w.active })).then((ok) => ok && onChanged())}>
                {w.active ? "Close" : "Reopen"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          void act.run("add", () => admin.createWarehouse(code.trim(), name.trim())).then((ok) => ok && (setCode(""), setName(""), onChanged()));
        }}>
          <input className="field h-10 w-24 shrink-0 px-3 font-mono text-sm uppercase" placeholder="Code" required maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Branch code" />
          <input className="field h-10 min-w-0 flex-1 px-3 text-sm" placeholder="Name, e.g. Leeds trade counter" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} aria-label="Branch name" />
          <button className="btn-ghost shrink-0" disabled={!!act.busy}>Add</button>
        </form>
      )}
      <ErrorText error={act.error} />
    </>
  );
}

function ProductEditor({ product, tiers, warehouses, currency, onClose, onSaved }: { product: Product | null; tiers: Tier[]; warehouses: Warehouse[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [f, setF] = useState({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    barcode: product?.barcode ?? "",
    uom: product?.uom ?? "EA",
    packSize: String(product?.packSize ?? 1),
    list: product ? toMoneyInput(product.listMinor) : "",
    leadTime: String(product?.leadTimeDays ?? 0),
    active: product?.active ?? true,
  });
  const [levels, setLevels] = useState<Record<string, string>>(() => Object.fromEntries(warehouses.map((w) => [w.id, String(product?.levels.find((l) => l.warehouseId === w.id)?.qty ?? 0)])));
  const [ladders, setLadders] = useState<Record<string, Array<{ minQty: string; price: string }>>>(() =>
    Object.fromEntries(tiers.map((t) => [t.id, (product?.tierPrices ?? []).filter((x) => x.tierId === t.id).sort((a, b) => a.minQty - b.minQty).map((x) => ({ minQty: String(x.minQty), price: toMoneyInput(x.unitMinor) }))])),
  );
  const total = Object.values(levels).reduce((s, v) => s + Number(v || 0), 0);

  async function save() {
    const listMinor = parseMoney(f.list);
    if (listMinor === null) throw Object.assign(new Error("Enter a valid list price."), { code: "LOCAL" });
    const body = { name: f.name.trim(), description: f.description.trim() || null, barcode: f.barcode.trim() || null, uom: f.uom.trim() || "EA", packSize: Number(f.packSize || 1), listMinor, leadTimeDays: Number(f.leadTime || 0), active: f.active };
    const id = product ? (await admin.updateProduct(product.id, body), product.id) : (await admin.createProduct({ ...body, sku: f.sku.trim(), stock: 0 })).id;
    if (warehouses.length) await admin.setStock(id, warehouses.map((w) => ({ warehouseId: w.id, qty: Number(levels[w.id] || 0) })));
    for (const t of tiers) {
      const rows = (ladders[t.id] ?? []).filter((r) => r.minQty && r.price);
      const before = (product?.tierPrices ?? []).filter((x) => x.tierId === t.id);
      if (!rows.length && !before.length) continue;
      const breaks = rows.map((r) => ({ minQty: Number(r.minQty), unitMinor: parseMoney(r.price) }));
      if (breaks.some((b) => b.unitMinor === null)) throw Object.assign(new Error(`Check the ${t.name} prices.`), { code: "LOCAL" });
      await admin.setTierPrices(id, t.id, breaks as Array<{ minQty: number; unitMinor: number }>);
    }
  }

  return (
    <Modal title={product ? `Edit ${product.sku}` : "Add product"} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault();
        void act.run("save", save).then((ok) => ok && (onSaved(), onClose()));
      }}>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_180px]">
          <Field label="SKU"><input className={`${inputCls} font-mono uppercase`} required disabled={!!product} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
          <Field label="Name"><input className={inputCls} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Barcode (EAN/UPC)"><input className={`${inputCls} font-mono`} inputMode="numeric" maxLength={32} value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value.trim() })} /></Field>
        </div>
        <Field label="Description (optional)"><textarea className="field w-full px-3 py-2 text-sm" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Unit"><input className={`${inputCls} uppercase`} value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} /></Field>
          <Field label="Pack size"><input className={`${inputCls} num`} inputMode="numeric" value={f.packSize} onChange={(e) => setF({ ...f, packSize: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label={`List price (${currency})`}><input className={`${inputCls} num`} inputMode="decimal" required value={f.list} onChange={(e) => setF({ ...f, list: e.target.value })} /></Field>
          <Field label="Lead time (days)" hint="Shown when out of stock"><input className={`${inputCls} num`} inputMode="numeric" value={f.leadTime} onChange={(e) => setF({ ...f, leadTime: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        {warehouses.length > 0 && (
          <div className="glass-inset p-3">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold"><span>Stock by branch</span><span className="num text-muted">Total {total}</span></div>
            <div className="grid gap-2 sm:grid-cols-3">
              {warehouses.map((w) => (
                <Field key={w.id} label={`${w.name} (${w.code})`}>
                  <input className={`${inputCls} num`} inputMode="numeric" value={levels[w.id] ?? "0"} onChange={(e) => setLevels({ ...levels, [w.id]: e.target.value.replace(/\D/g, "") })} />
                </Field>
              ))}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Visible to customers</label>

        {tiers.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Tier prices</h3>
            {tiers.map((t) => (
              <div key={t.id} className="glass-inset p-3">
                <div className="mb-2 text-xs font-semibold">{t.name}</div>
                <div className="space-y-2">
                  {(ladders[t.id] ?? []).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-muted">From</span>
                      <input className={`${inputCls} num h-9 w-20`} inputMode="numeric" value={r.minQty} aria-label="Minimum quantity"
                        onChange={(e) => setLadders({ ...ladders, [t.id]: ladders[t.id]!.map((x, j) => (j === i ? { ...x, minQty: e.target.value.replace(/\D/g, "") } : x)) })} />
                      <span className="text-muted">units at</span>
                      <input className={`${inputCls} num h-9 w-28`} inputMode="decimal" value={r.price} aria-label="Unit price"
                        onChange={(e) => setLadders({ ...ladders, [t.id]: ladders[t.id]!.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
                      <button type="button" className="text-muted hover:text-danger" onClick={() => setLadders({ ...ladders, [t.id]: ladders[t.id]!.filter((_, j) => j !== i) })}>Remove</button>
                    </div>
                  ))}
                  <button type="button" className="text-xs font-medium text-accent" onClick={() => setLadders({ ...ladders, [t.id]: [...(ladders[t.id] ?? []), { minQty: (ladders[t.id] ?? []).length ? "" : "1", price: "" }] })}>
                    + Add price break
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <ErrorText error={act.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!act.busy}>{act.busy ? "Saving…" : "Save product"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Minimal RFC 4180 CSV reader (quoted fields, embedded commas and quotes). */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";" || c === "\t") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function toRows(text: string): { rows: ImportRow[]; problems: string[] } {
  const grid = readCsv(text.replace(/^﻿/, ""));
  const head = (grid.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iSku = col("sku", "code", "product_code", "item_code");
  if (iSku === -1) return { rows: [], problems: ["The first row must be a header with a “sku” column."] };
  const iName = col("name", "description_short", "title");
  const iDesc = col("description");
  const iBarcode = col("barcode", "ean", "upc", "gtin");
  const iUom = col("uom", "unit");
  const iPack = col("pack_size", "pack", "packsize");
  const iList = col("list_price", "price", "list");
  const iLead = col("lead_time_days", "lead_time", "leadtime");
  const iActive = col("active", "visible");
  const stockCols = head.map((h, i) => [h, i] as const).filter(([h]) => h.startsWith("stock_"));
  const problems: string[] = [];
  const rows: ImportRow[] = [];
  grid.forEach((r, n) => {
    const v = (i: number) => (i === -1 ? undefined : r[i]?.trim() || undefined);
    const sku = v(iSku);
    if (!sku) return;
    const row: ImportRow = { sku };
    if (v(iName)) row.name = v(iName);
    if (iDesc !== -1) row.description = v(iDesc) ?? null;
    if (iBarcode !== -1) row.barcode = v(iBarcode) ?? null;
    if (v(iUom)) row.uom = v(iUom);
    if (v(iPack)) row.packSize = Number(v(iPack));
    if (v(iList)) {
      const m = parseMoney(v(iList)!);
      if (m === null) problems.push(`Row ${n + 2}: list price “${v(iList)}” is not a number`);
      else row.listMinor = m;
    }
    if (v(iLead)) row.leadTimeDays = Number(v(iLead));
    if (v(iActive)) row.active = !/^(no|false|0|hidden)$/i.test(v(iActive)!);
    if (stockCols.length) row.stock = Object.fromEntries(stockCols.filter(([, i]) => v(i) !== undefined).map(([h, i]) => [h.slice(6).toUpperCase(), Number(v(i)!.replace(/\D/g, "") || 0)]));
    rows.push(row);
  });
  return { rows, problems };
}

function ImportDialog({ warehouses, onClose, onDone }: { warehouses: Warehouse[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ rows: ImportRow[]; problems: string[]; name: string } | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; errors: Array<{ sku: string; error: string }> } | null>(null);
  const example = `sku,name,barcode,uom,pack_size,list_price,lead_time_days,active,${warehouses.map((w) => `stock_${w.code}`).join(",")}`;

  return (
    <Modal title="Import products from CSV" onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Adds new products and updates existing ones by SKU. Only the columns present are changed, so a file with just <code className="font-mono">sku</code> and <code className="font-mono">stock_…</code> columns updates stock only. Export first to get a ready-made template.
        </p>
        <code className="block overflow-x-auto whitespace-nowrap rounded-xl bg-surface/60 px-3 py-2 font-mono text-[11px]">{example}</code>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Choose CSV file</button>
          <a className="btn-ghost" href={admin.exportUrl("products")} download><Download className="h-4 w-4" /> Download current catalogue</a>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setResult(null);
            setParsed({ ...toRows(await f.text()), name: f.name });
          }} />
        </div>
        {parsed && (
          <div className="glass-inset p-3 text-xs">
            <div className="font-semibold">{parsed.name}: {parsed.rows.length} product row{parsed.rows.length === 1 ? "" : "s"} ready</div>
            {parsed.problems.slice(0, 8).map((p) => <div key={p} className="mt-1 text-danger">{p}</div>)}
          </div>
        )}
        {result && (
          <div className="rounded-2xl border border-ok/30 bg-ok/10 p-3 text-xs">
            <div className="font-semibold">{result.created} created, {result.updated} updated{result.errors.length ? `, ${result.errors.length} skipped` : ""}.</div>
            {result.errors.slice(0, 10).map((e) => <div key={e.sku} className="mt-1 text-danger">{e.sku}: {e.error.replace(/_/g, " ").toLowerCase()}</div>)}
          </div>
        )}
        <ErrorText error={act.error} />
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          <button className="btn-primary" disabled={!parsed?.rows.length || !!act.busy || !!result} onClick={() => void act.run("import", async () => {
            setResult(await admin.importProducts(parsed!.rows));
            onDone();
          })}>
            {act.busy ? "Importing…" : `Import ${parsed?.rows.length ?? ""} rows`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
