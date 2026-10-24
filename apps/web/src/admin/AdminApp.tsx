import QRCode from "qrcode";
import { Boxes, Building2, FileText, LayoutGrid, LogOut, PackageCheck, Plug, Settings, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Logo, ThemeToggle } from "../components/TopBar";
import { ApiError, auth } from "../lib/api";
import { admin, type Overview } from "../lib/admin";
import { navigate, type Theme } from "../lib/nav";
import { AuthShell } from "../pages/AuthPages";
import { AccountsPage } from "./AccountsPage";
import { CataloguePage } from "./CataloguePage";
import { OrdersPage, QuotesPage } from "./OrdersQuotes";
import { OverviewPage, SecurityPage, SettingsPage, TeamPage } from "./SystemPages";
import { IntegrationsPage } from "./IntegrationsPage";
import { ErrorText, useLoad } from "./ui";
import { NoticeToasts, NotificationBell, useNotifications } from "./Notifications";

type Page = "overview" | "accounts" | "orders" | "quotes" | "catalogue" | "team" | "integrations" | "security" | "settings";

const items: Array<{ id: Page; label: string; icon: LucideIcon; adminOnly?: boolean }> = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "accounts", label: "Accounts", icon: Building2 },
  { id: "orders", label: "Orders", icon: PackageCheck },
  { id: "quotes", label: "Quotes", icon: FileText },
  { id: "catalogue", label: "Catalogue", icon: Boxes },
  { id: "team", label: "Team", icon: Users, adminOnly: true },
  { id: "integrations", label: "Integrations", icon: Plug, adminOnly: true },
  { id: "security", label: "Security", icon: ShieldCheck, adminOnly: true },
  { id: "settings", label: "Settings", icon: Settings, adminOnly: true },
];

export const adminPageFromPath = (path: string): Page => {
  const seg = path.replace(/^\/admin\/?/, "").split("/")[0] as Page;
  return items.some((i) => i.id === seg) ? seg : "overview";
};

/**
 * Admin portal for staff (ADMIN, SALES_REP). Same visual system as the trade portal: glass top
 * bar, page heading, floating dock. Server enforces every permission; the UI only hides what a
 * role can't use.
 */
export function AdminApp({ path, theme, onToggleTheme, onSignOut, mfaEnabled, onMfaEnabled }: {
  path: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  mfaEnabled: boolean;
  onMfaEnabled: () => void;
}) {
  if (!mfaEnabled) return <MandatoryMfa onDone={onMfaEnabled} onSignOut={onSignOut} />;
  return <AdminShell path={path} theme={theme} onToggleTheme={onToggleTheme} onSignOut={onSignOut} />;
}

function AdminShell({ path, theme, onToggleTheme, onSignOut }: { path: string; theme: Theme; onToggleTheme: () => void; onSignOut: () => void }) {
  const page = adminPageFromPath(path);
  const ov = useLoad(() => admin.overview(), [page]);
  // Live events refresh the overview counts so badges and stat cards stay current.
  const notices = useNotifications(() => void ov.reload());
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    if (ov.data) setData(ov.data);
  }, [ov.data]);

  if (!data) return <div className="grid min-h-screen place-items-center text-sm text-muted">{ov.error ? <ErrorText error={ov.error} /> : "Loading admin portal…"}</div>;
  const isAdmin = data.me.role === "ADMIN";
  const visible = items.filter((i) => isAdmin || !i.adminOnly);
  const go = (p: string) => {
    navigate(p === "overview" ? "/admin" : `/admin/${p}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const initials = data.me.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

  return (
    <div className="portal-shell mx-auto max-w-[1440px] px-4 pb-36 pt-4 sm:px-6 lg:px-8">
      <div className="sticky top-3 z-20">
        <header className="glass flex items-center gap-3 rounded-full px-3 py-2 sm:gap-4 sm:px-4">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="chip hidden sm:inline-flex">Admin portal</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden rounded-full border border-line/70 bg-surface/60 px-3 py-1.5 leading-tight lg:block dark:border-line/[0.07]">
              <span className="block max-w-[220px] truncate text-xs font-semibold">{data.business}</span>
              <span className="block text-[11px] text-muted">{isAdmin ? "Administrator" : "Account manager"}</span>
            </div>
            <NotificationBell state={notices} />
            <ThemeToggle theme={theme} onToggleTheme={onToggleTheme} />
            <div className="flex items-center gap-2.5 pl-1">
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-sm font-semibold">{data.me.name}</div>
                <div className="text-[11px] text-muted">{data.me.email}</div>
              </div>
              <div className="grid h-9 w-9 place-items-center rounded-full bg-accent text-xs font-semibold text-onaccent ring-2 ring-surface/70">{initials}</div>
            </div>
            <button onClick={onSignOut} className="grid h-9 w-9 place-items-center rounded-full border border-line/70 bg-surface/60 transition hover:bg-surface dark:border-line/[0.07]" aria-label="Sign out" title="Sign out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
      </div>

      <NoticeToasts state={notices} />
      <main className="mt-6" key={page}>
        {page === "overview" && <OverviewPage data={data} go={go} />}
        {page === "accounts" && <AccountsPage isAdmin={isAdmin} />}
        {page === "orders" && <OrdersPage />}
        {page === "quotes" && <QuotesPage />}
        {page === "catalogue" && <CataloguePage isAdmin={isAdmin} currency={data.currency} />}
        {page === "team" && isAdmin && <TeamPage myId={data.me.id} />}
        {page === "integrations" && isAdmin && <IntegrationsPage />}
        {page === "security" && isAdmin && <SecurityPage />}
        {page === "settings" && isAdmin && <SettingsPage onSaved={() => void ov.reload()} />}
      </main>

      <nav aria-label="Admin" className="fixed inset-x-0 bottom-3 z-30 flex justify-center px-3 pb-[env(safe-area-inset-bottom)]">
        <ul className="glass dock-material flex max-w-full gap-1 overflow-x-auto rounded-[22px] p-1.5 shadow-dock">
          {visible.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button onClick={() => go(id)} aria-current={id === page ? "page" : undefined} className={`dock-item ${id === page ? "dock-item--active" : ""}`}>
                <span className="dock-item__icon"><Icon className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** Staff cannot use the admin portal until an authenticator is confirmed. */
function MandatoryMfa({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { otpauthUri } = await auth.mfaSetup();
        setSecret(new URL(otpauthUri).searchParams.get("secret") ?? "");
        setQr(await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 }));
      } catch (e) {
        setError((e as ApiError).message);
      }
    })();
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.mfaConfirm(code);
      onDone();
    } catch {
      setError("That code didn't match. Check the time on your phone and try the next code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <ShieldCheck className="h-7 w-7 text-accent" />
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Secure your admin account</h1>
      <p className="mt-1 text-sm text-muted">Staff accounts need two-step verification. Scan this with Google Authenticator, Microsoft Authenticator, 1Password or similar.</p>
      <div className="mt-5 grid place-items-center">
        {qr ? <img src={qr} alt="Authenticator QR code" className="h-48 w-48 rounded-xl bg-white p-2" /> : <div className="h-48 w-48 animate-pulse rounded-xl bg-muted/15" />}
      </div>
      {secret && <p className="mt-3 text-center text-[11px] text-muted">Or enter key <span className="select-all break-all font-mono text-ink">{secret}</span></p>}
      <form onSubmit={confirm} className="mt-4 space-y-3">
        <label className="block">
          <span className="label">6-digit code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus className="glass-strong num mt-1 h-11 w-full px-3.5 text-center text-sm tracking-[0.4em]" />
        </label>
        <ErrorText error={error} />
        <button className="btn-primary w-full" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Turn on and continue"}</button>
      </form>
      <button className="mt-4 text-xs text-muted hover:text-ink" onClick={onSignOut}>Sign out</button>
    </AuthShell>
  );
}
