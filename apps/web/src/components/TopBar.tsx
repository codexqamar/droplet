import { ChevronDown, Lock, LogOut, Moon, Plus, RefreshCw, Search, Sun, X } from "lucide-react";
import { useRef, useState } from "react";
import { FloatingMenu } from "./FloatingMenu";
import { relative } from "../lib/format";
import type { DesktopAccount } from "../lib/api";
import type { AccountContext } from "../lib/types";

const roleLabel = { TRADE_CUSTOMER: "Trade buyer", SALES_REP: "Account manager", ADMIN: "Administrator" } as const;

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden>
        <path d="M16 3c4.5 6 9 10.6 9 15.5A9 9 0 0 1 7 18.5C7 13.6 11.5 9 16 3Z" fill="rgb(var(--accent))" />
        <path d="M12.2 19.5a4 4 0 0 0 3.8 3.5" stroke="white" strokeOpacity=".85" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
      <div className="text-left leading-none">
        <div className="text-[15px] font-bold tracking-[0.14em]">DROPLET</div>
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted">Trade portal</div>
      </div>
    </div>
  );
}

const iconBtn = "grid h-9 w-9 place-items-center rounded-full border border-line/70 bg-surface/60 transition hover:bg-surface dark:border-line/[0.07]";

export function ThemeToggle({ theme, onToggleTheme }: { theme: "light" | "dark"; onToggleTheme: () => void }) {
  return (
    <button onClick={onToggleTheme} className={iconBtn} aria-label="Toggle theme">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function TopBar({
  account,
  theme,
  onToggleTheme,
  onSearch,
  onSignOut,
  onLock,
  sync,
  desktopAccounts,
}: {
  account: AccountContext;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSearch: () => void;
  onSignOut?: () => void;
  onLock?: () => void;
  sync?: { lastSyncAt: number | null | undefined; busy: boolean; offline: boolean; onSync: () => void };
  desktopAccounts?: { accounts: DesktopAccount[]; activeProfileId: string; onAdd: () => void; onSwitch: (id: string) => void; onRemove?: (id: string) => void };
}) {
  const [accountsOpen, setAccountsOpen] = useState(false);
  const accountsAnchor = useRef<HTMLButtonElement>(null);
  return (
    <header className="glass flex items-center gap-3 rounded-full px-3 py-2 sm:gap-4 sm:px-4">
      <Logo />

      <button
        onClick={onSearch}
        className="ml-2 hidden min-w-0 flex-1 items-center gap-2 rounded-full border border-line/70 bg-surface/60 px-4 py-2 text-left text-sm text-muted transition hover:bg-surface/90 md:flex dark:border-line/[0.07]"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">Search catalogue by SKU or description</span>
        <kbd className="ml-auto rounded-md border border-line/80 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted dark:border-line/[0.07]">/</kbd>
      </button>

      <div className="ml-auto flex items-center gap-2 md:ml-0">
        <div className="relative hidden lg:block">
          <button ref={accountsAnchor} type="button" onClick={() => desktopAccounts && setAccountsOpen((open) => !open)}
            className="flex items-center gap-2 rounded-full border border-line/70 bg-surface/60 px-3 py-1.5 text-left leading-tight dark:border-line/[0.07]">
            <span><span className="block max-w-[220px] truncate text-xs font-semibold">{account.legalName}</span><span className="block text-[11px] text-muted">{account.code} · {account.tier}</span></span>
            {desktopAccounts && <ChevronDown className="h-3.5 w-3.5 text-muted" />}
          </button>
          {desktopAccounts && <FloatingMenu anchor={accountsAnchor} open={accountsOpen} onClose={() => setAccountsOpen(false)} label="Trade accounts" className="min-w-64 p-2">
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Trade accounts</div>
            {desktopAccounts.accounts.filter((item) => item.enrolled).map((item) => {
              const active = item.id === desktopAccounts.activeProfileId;
              return (
                <div key={item.id} className={`group flex items-center gap-1 rounded-xl hover:bg-surface/80 ${active ? "bg-surface/65" : ""}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center justify-between px-2.5 py-2 text-left"
                    onClick={() => { setAccountsOpen(false); if (!active) desktopAccounts.onSwitch(item.id); }}>
                    <span className="min-w-0"><span className="block truncate text-xs font-semibold">{item.legalName ?? item.label}</span><span className="block text-[10px] text-muted">{item.code ?? item.label}{item.status && item.status !== "APPROVED" ? ` · ${item.status.toLowerCase()}` : ""}</span></span>
                    {active && <span className="h-2 w-2 shrink-0 rounded-full bg-ok" />}
                  </button>
                  {!active && desktopAccounts.onRemove && (
                    <button type="button" className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Remove ${item.legalName ?? item.label} from this computer`} title="Remove from this computer"
                      onClick={() => { setAccountsOpen(false); desktopAccounts.onRemove!(item.id); }}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </FloatingMenu>}
        </div>

        {desktopAccounts && <button type="button" onClick={desktopAccounts.onAdd} className={iconBtn}
          title="Add trade account" aria-label="Add trade account"><Plus className="h-4 w-4" /></button>}

        {sync && (
          <button
            onClick={sync.onSync}
            disabled={sync.busy}
            className={`relative ${iconBtn} disabled:opacity-70`}
            title={sync.busy ? "Syncing…" : sync.offline ? "Offline. Select to retry sync" : sync.lastSyncAt ? `Synced ${relative(new Date(sync.lastSyncAt).toISOString())}. Select to sync now` : "Sync now"}
            aria-label="Sync now"
          >
            <RefreshCw className={`h-4 w-4 ${sync.busy ? "animate-spin" : ""}`} />
            <span className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-surface ${sync.offline ? "bg-warn" : "bg-ok"}`} aria-hidden />
          </button>
        )}

        <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />

        <div className="flex items-center gap-2.5 pl-1">
          <div className="hidden text-right leading-tight sm:block">
            <div className="text-sm font-semibold">{account.user.name}</div>
            <div className="text-[11px] text-muted">{roleLabel[account.user.role]}</div>
          </div>
          <div className="grid h-9 w-9 place-items-center rounded-full bg-accent text-xs font-semibold text-onaccent ring-2 ring-surface/70">
            {account.user.initials}
          </div>
        </div>
        {onLock && (
          <button onClick={onLock} className={iconBtn} aria-label="Lock DROPLET" title="Lock DROPLET (password and authenticator code to unlock)">
            <Lock className="h-4 w-4" />
          </button>
        )}
        {onSignOut && (
          <button onClick={onSignOut} className={iconBtn} aria-label="Sign out" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}
