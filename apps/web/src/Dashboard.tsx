import { CloudOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dock, type PortalPage } from "./components/Dock";
import { MfaSetup } from "./components/MfaSetup";
import { TopBar } from "./components/TopBar";
import { auth, isDesktop, portal } from "./lib/api";
import type { DesktopAccount } from "./lib/api";
import { navigate, type Theme } from "./lib/nav";
import type { Dashboard as Data, LineItem } from "./lib/types";
import { CataloguePage, DashboardOverview, OrdersPage, QuickOrderPage, QuotesPage, StatementsPage, type OrderActions } from "./pages/PortalPages";

const statusMessage: Record<string, string> = {
  SUBMITTED: "submitted. Confirmation is on its way.",
  PENDING_APPROVAL: "sent for credit approval.",
  DRAFT: "saved as a draft.",
};

export function portalPageFromPath(path: string): PortalPage {
  if (path.endsWith("/quick-order")) return "quick-order";
  if (path.endsWith("/catalogue")) return "catalogue";
  if (path.endsWith("/orders")) return "orders";
  if (path.endsWith("/quotes")) return "quotes";
  if (path.endsWith("/statements")) return "statements";
  return "dashboard";
}

export function Dashboard({ data, reload, theme, path, onToggleTheme, onSignOut, desktopCtx }: {
  data: Data;
  reload: () => Promise<void>;
  theme: Theme;
  path: string;
  onToggleTheme: () => void;
  onSignOut?: () => void;
  desktopCtx?: { deviceId: string | null; version: string; offline: boolean; syncing: boolean; accounts: DesktopAccount[]; activeProfileId: string; onSync: () => void; onAddAccount: () => void; onSwitchAccount: (id: string) => void; onRemoveAccount?: (id: string) => void; onLock?: () => void };
}) {
  const page = portalPageFromPath(path);
  const [inject, setInject] = useState<{ nonce: number; lines: LineItem[] } | null>(null);
  const skuRef = useRef<HTMLInputElement>(null);

  const openQuickOrder = (lines?: LineItem[]) => {
    if (lines) setInject({ nonce: Date.now(), lines });
    navigate("/app/quick-order");
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => skuRef.current?.focus({ preventScroll: true }), 120);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
        event.preventDefault();
        openQuickOrder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const actions: OrderActions = {
    inject,
    skuRef,
    onPlace: async (lines, po, mode) => {
      const result = await portal.placeOrder(lines, po, mode);
      await reload();
      if (result.queued) return "Order saved offline. It will send at the next sync.";
      return `Order ${result.number} ${statusMessage[result.status] ?? result.status}`;
    },
    onQuote: async (lines) => {
      const result = await portal.requestQuote(lines);
      await reload();
      return `Quote request ${result.number} sent.`;
    },
    onReorder: (order) => openQuickOrder(order.items),
  };

  return (
    <div className="portal-shell mx-auto max-w-[1440px] px-4 pb-36 pt-4 sm:px-6 lg:px-8">
      <div className="sticky top-3 z-20">
        <TopBar account={data.account} theme={theme} onToggleTheme={onToggleTheme} onSearch={() => openQuickOrder()} onSignOut={onSignOut}
          desktopAccounts={desktopCtx ? { accounts: desktopCtx.accounts, activeProfileId: desktopCtx.activeProfileId, onAdd: desktopCtx.onAddAccount, onSwitch: desktopCtx.onSwitchAccount, onRemove: desktopCtx.onRemoveAccount } : undefined}
          onLock={desktopCtx?.onLock}
          sync={desktopCtx ? { lastSyncAt: data.lastSyncAt, busy: desktopCtx.syncing, offline: desktopCtx.offline, onSync: desktopCtx.onSync } : undefined} />
      </div>

      {desktopCtx?.offline && <div className="glass mt-4 flex items-center gap-3 px-4 py-3 text-sm"><CloudOff className="h-4 w-4 shrink-0 text-warn" /><span>Offline mode. Catalogue and pricing remain available; new orders will send at the next sync.</span></div>}
      {!isDesktop && !data.mfaEnabled && page === "dashboard" && <div className="mt-4"><MfaSetup onDone={() => void reload()} /></div>}

      <main className="mt-6" key={page}>
        {page === "dashboard" && <DashboardOverview data={data} onReorder={actions.onReorder} desktopCtx={desktopCtx ? { deviceId: desktopCtx.deviceId, version: desktopCtx.version } : undefined} />}
        {page === "quick-order" && <QuickOrderPage data={data} actions={actions} allowDraft={!isDesktop} />}
        {page === "catalogue" && <CataloguePage data={data} onOrder={(lines) => openQuickOrder(lines)} />}
        {page === "orders" && <OrdersPage data={data} onReorder={actions.onReorder} />}
        {page === "quotes" && <QuotesPage data={data} onAccept={isDesktop ? undefined : async (number) => {
          const r = await auth.acceptQuote(number);
          await reload();
          return `Order ${r.number} ${statusMessage[r.status] ?? r.status}`;
        }} />}
        {page === "statements" && <StatementsPage data={data} />}
      </main>

      <Dock active={page} onSelect={(next) => { navigate(next === "dashboard" ? "/app" : `/app/${next}`); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
    </div>
  );
}
