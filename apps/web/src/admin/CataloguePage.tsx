import { Boxes, Plus, Tags } from "lucide-react";
import { useMemo, useState } from "react";
import { admin, parseMoney, toMoneyInput, type Product, type Tier } from "../lib/admin";
import { money } from "../lib/format";
import { Badge, EmptyState, ErrorText, Field, inputCls, Modal, PageHeading, Panel, SearchBox, useAction, useLoad } from "./ui";

export function CataloguePage({ isAdmin, currency }: { isAdmin: boolean; currency: string }) {
  const data = useLoad(() => admin.products(), []);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [tierName, setTierName] = useState("");
  const act = useAction();
  const products = useMemo(() => {
    const t = q.trim().toUpperCase();
    return (data.data?.products ?? []).filter((p) => !t || p.sku.includes(t) || p.name.toUpperCase().includes(t));
  }, [data.data, q]);

  return (
    <div className="space-y-5">
      <PageHeading
        title="Catalogue & pricing"
        description="Products, stock and list prices, plus price tiers with quantity breaks. Changes reach desktop apps on their next sync."
        action={isAdmin && <button className="btn-primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add product</button>}
      />

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

      <Panel>
        <div className="mb-3"><SearchBox value={q} onChange={setQ} placeholder="Search SKU or name" /></div>
        {!data.loading && products.length === 0 && <EmptyState icon={Boxes} title={q ? "No matches" : "No products yet"} body={q ? "Try another search." : "Add your first product to start taking orders."} />}
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            {products.length > 0 && (
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-1 pb-2 font-medium">Product</th>
                  <th className="px-1 pb-2 font-medium">Unit</th>
                  <th className="px-1 pb-2 text-right font-medium">Stock</th>
                  <th className="px-1 pb-2 text-right font-medium">List price</th>
                  <th className="px-1 pb-2 font-medium">Tier prices</th>
                  <th className="px-1 pb-2 font-medium">Status</th>
                </tr>
              </thead>
            )}
            <tbody>
              {products.map((p) => (
                <tr key={p.id} onClick={() => isAdmin && setEditing(p)} className={`border-t border-line/60 dark:border-line/[0.07] ${isAdmin ? "cursor-pointer hover:bg-surface/40" : ""}`}>
                  <td className="px-1 py-3"><div className="font-mono text-xs font-semibold">{p.sku}</div><div className="max-w-[22rem] truncate">{p.name}</div></td>
                  <td className="px-1 py-3 text-muted">{p.uom}{p.packSize > 1 ? ` × ${p.packSize}` : ""}</td>
                  <td className={`num px-1 py-3 text-right ${p.stock === 0 ? "text-danger" : ""}`}>{p.stock}</td>
                  <td className="num px-1 py-3 text-right font-semibold">{money(p.listMinor, currency)}</td>
                  <td className="px-1 py-3 text-xs text-muted">{p.tierPrices.length ? `${new Set(p.tierPrices.map((t) => t.tierId)).size} tier(s)` : "—"}</td>
                  <td className="px-1 py-3">{p.active ? <Badge label="Active" tone="ok" /> : <Badge label="Hidden" tone="muted" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {editing && <ProductEditor product={editing === "new" ? null : editing} tiers={data.data?.tiers ?? []} currency={currency} onClose={() => setEditing(null)} onSaved={() => void data.reload()} />}
    </div>
  );
}

function ProductEditor({ product, tiers, currency, onClose, onSaved }: { product: Product | null; tiers: Tier[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [f, setF] = useState({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    uom: product?.uom ?? "EA",
    packSize: String(product?.packSize ?? 1),
    list: product ? toMoneyInput(product.listMinor) : "",
    stock: String(product?.stock ?? 0),
    active: product?.active ?? true,
  });
  // tierId -> "minQty:price, minQty:price"
  const [ladders, setLadders] = useState<Record<string, Array<{ minQty: string; price: string }>>>(() =>
    Object.fromEntries(tiers.map((t) => [t.id, (product?.tierPrices ?? []).filter((x) => x.tierId === t.id).sort((a, b) => a.minQty - b.minQty).map((x) => ({ minQty: String(x.minQty), price: toMoneyInput(x.unitMinor) }))])),
  );

  async function save() {
    const listMinor = parseMoney(f.list);
    if (listMinor === null) throw Object.assign(new Error("Enter a valid list price."), { code: "LOCAL" });
    const body = { name: f.name.trim(), description: f.description.trim() || null, uom: f.uom.trim() || "EA", packSize: Number(f.packSize || 1), listMinor, stock: Number(f.stock || 0), active: f.active };
    const id = product ? (await admin.updateProduct(product.id, body), product.id) : (await admin.createProduct({ ...body, sku: f.sku.trim() })).id;
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
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <Field label="SKU"><input className={`${inputCls} font-mono uppercase`} required disabled={!!product} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
          <Field label="Name"><input className={inputCls} required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="Description (optional)"><textarea className="field w-full px-3 py-2 text-sm" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Unit"><input className={`${inputCls} uppercase`} value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} /></Field>
          <Field label="Pack size"><input className={`${inputCls} num`} inputMode="numeric" value={f.packSize} onChange={(e) => setF({ ...f, packSize: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label={`List price (${currency})`}><input className={`${inputCls} num`} inputMode="decimal" required value={f.list} onChange={(e) => setF({ ...f, list: e.target.value })} /></Field>
          <Field label="Stock"><input className={`${inputCls} num`} inputMode="numeric" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
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
