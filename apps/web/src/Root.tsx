import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LockScreen } from "./components/LockScreen";
import { DesktopChrome } from "./components/DesktopChrome";
import { Dashboard } from "./Dashboard";
import { ApiError, auth, desktop, isDesktop, portal, SIGNED_OUT_EVENT, type DesktopAccount, type Me } from "./lib/api";
import { navigate, usePath, useTheme, type Theme } from "./lib/nav";
import type { Dashboard as Data, SecurityState } from "./lib/types";
import { ApplyPage, AuthShell, LoginPage, PendingPage } from "./pages/AuthPages";
import { DesktopGate } from "./pages/DesktopGate";
import { AppLockScreen } from "./pages/AppLockScreen";
import { InvitePage, SetupPage } from "./pages/OnboardingPages";
import { AdminApp } from "./admin/AdminApp";
import { Landing } from "./pages/Landing";

function Splash({ text = "Loading your portal…" }: { text?: string }) {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex items-center gap-3 text-sm text-muted">
        <RefreshCw className="h-4 w-4 animate-spin text-accent" /> {text}
      </div>
    </div>
  );
}

function Problem({ title, body, action }: { title: string; body: string; action?: { label: string; run: () => void } }) {
  return (
    <AuthShell>
      <AlertTriangle className="h-7 w-7 text-warn" />
      <h1 className="mt-3 text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{body}</p>
      {action && (
        <button className="btn-primary mt-6 w-full" onClick={action.run}>
          {action.label}
        </button>
      )}
    </AuthShell>
  );
}

/** Maps an ACCOUNT_NOT_APPROVED detail ("PENDING_APPROVAL" | "REJECTED:reason" | ...) to /pending. */
function goPending(detail?: string) {
  const [status, ...rest] = (detail ?? "PENDING_APPROVAL").split(":");
  const reason = rest.join(":");
  const q = new URLSearchParams({ status: status || "PENDING_APPROVAL", ...(reason ? { reason } : {}) });
  navigate(`/pending?${q.toString()}`, true);
}

/**
 * Web: public landing/login/apply/setup/invite. /app is the trade portal, /admin the staff
 * admin portal; both sit behind the session gate and each role is sent to its own portal.
 */
function WebRoot() {
  const path = usePath();
  const isAppRoute = path === "/app" || path.startsWith("/app/");
  const isAdminRoute = path === "/admin" || path.startsWith("/admin/");
  const [theme, toggleTheme] = useTheme();
  const [session, setSession] = useState<"unknown" | "anon" | "trade" | "staff">("unknown");
  const [me, setMe] = useState<Me | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [lock, setLock] = useState<SecurityState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await auth.me();
      setMe(who);
      setLock(null);
      setFailure(null);
      if (who.staff) {
        setData(null);
        setSession("staff");
      } else {
        setData(await portal.dashboard());
        setSession("trade");
      }
    } catch (e) {
      const a = e as ApiError;
      setData(null);
      setMe(null);
      setSession("anon");
      if (a.code === "ACCOUNT_SECURITY_LOCK") setLock((a.detail as SecurityState) || "LOCKED_TAMPER");
      else if (a.code === "ACCOUNT_NOT_APPROVED") goPending(a.detail);
      else if (a.status !== 401 && a.status !== 403) setFailure(a.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Session ended mid-use (expired, revoked, deactivated): re-check and fall back to sign-in.
  useEffect(() => {
    const onSignedOut = () => void load();
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [load]);

  // The gate: each role lands in its own portal; nobody reaches a portal without a session.
  useEffect(() => {
    if (session === "trade" && (path === "/" || path === "/login" || isAdminRoute)) navigate("/app", true);
    if (session === "staff" && (path === "/" || path === "/login" || isAppRoute)) navigate("/admin", true);
    if (session === "anon" && !lock && (isAppRoute || isAdminRoute)) navigate("/login", true);
  }, [session, path, lock, isAppRoute, isAdminRoute]);

  const signOut = async () => {
    await auth.logout().catch(() => undefined);
    setData(null);
    setMe(null);
    setSession("anon");
    navigate("/");
  };

  if (path === "/security/recover") {
    return <LockScreen state={lock ?? "RECOVERY_PENDING"} token={new URLSearchParams(window.location.search).get("token")} />;
  }
  if (path === "/setup") return <SetupPage />;
  if (path === "/invite") return <InvitePage />;
  if (path === "/apply") return <ApplyPage />;
  if (path === "/pending") return <PendingPage />;
  if (session === "unknown") return <Splash />;
  if (lock) return <LockScreen state={lock} token={null} />;
  if (failure && path !== "/") {
    return <Problem title="DROPLET is unavailable" body={failure} action={{ label: "Try again", run: () => void load() }} />;
  }
  if (session === "staff" && me) {
    return (
      <AdminApp
        path={path}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSignOut={() => void signOut()}
        mfaEnabled={me.mfaEnabled}
        onMfaEnabled={() => setMe({ ...me, mfaEnabled: true })}
      />
    );
  }
  if (session === "trade" && data) {
    return <Dashboard data={data} reload={load} theme={theme} path={path} onToggleTheme={toggleTheme} onSignOut={() => void signOut()} />;
  }
  if (path === "/login" || isAppRoute || isAdminRoute) {
    return (
      <LoginPage
        onSignedIn={async () => {
          await load();
        }}
        onPending={goPending}
        onLocked={(s) => setLock(s as SecurityState)}
      />
    );
  }
  return <Landing theme={theme} onToggleTheme={toggleTheme} />;
}

type DesktopPhase =
  | { kind: "boot"; text?: string }
  | { kind: "enroll"; notice?: string }
  | { kind: "locked"; state: SecurityState }
  | { kind: "update" }
  | { kind: "offline-empty" }
  | { kind: "add-account" }
  | { kind: "suspended" }
  | { kind: "app-locked"; owner: { name?: string; email?: string } | null }
  | { kind: "service-down" }
  | { kind: "ready" };

/**
 * Desktop staff mode: admins and account managers sign in live against the cloud (through the
 * shell's in-memory session) and get the same admin portal as on the web.
 */
function DesktopStaff({ theme, onToggleTheme, onExit }: { theme: Theme; onToggleTheme: () => void; onExit: () => void }) {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await auth.me();
      if (!who.staff) {
        await auth.logout().catch(() => undefined);
        setNotice("That's a trade account. Trade buyers connect this computer with an enrollment code instead.");
        setMe(null);
      } else {
        setMe(who);
        if (!path.startsWith("/admin")) navigate("/admin", true);
      }
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }, [path]);

  useEffect(() => {
    void load();
    const onSignedOut = () => setMe(null);
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!checked) return <Splash text="Connecting to DROPLET…" />;
  if (!me) {
    return (
      <LoginPage
        title="Staff sign-in"
        subtitle="Administrators and account managers: sign in to open the admin portal."
        onSignedIn={() => void load()}
        onPending={() => setNotice("This account isn't approved yet.")}
        onLocked={() => setNotice("This account is locked.")}
        footer={
          <span className="flex w-full items-center justify-between gap-3">
            {notice ? <span className="text-danger">{notice}</span> : <span />}
            <button className="font-medium text-accent hover:underline" onClick={onExit}>Back to trade desktop</button>
          </span>
        }
      />
    );
  }
  return (
    <AdminApp
      path={path}
      theme={theme}
      onToggleTheme={onToggleTheme}
      mfaEnabled={me.mfaEnabled}
      onMfaEnabled={() => setMe({ ...me, mfaEnabled: true })}
      onSignOut={() => {
        void auth.logout().finally(() => {
          setMe(null);
          onExit();
        });
      }}
    />
  );
}

/**
 * Desktop: the app opens only for an enrolled install. Every launch re-attests with the cloud
 * (inside sync); a lock, revocation or tamper verdict replaces the portal entirely.
 */
function DesktopRoot() {
  const [staff, setStaff] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const exitStaff = () => {
    setStaff(false);
    navigate("/app", true);
  };
  return (
    <DesktopChrome context={staff ? "Admin portal" : "Trade desktop"} onAdmin={staff ? undefined : () => setStaff(true)}>
      {staff ? <DesktopStaff theme={theme} onToggleTheme={toggleTheme} onExit={exitStaff} /> : <DesktopTrade onStaff={() => setStaff(true)} />}
    </DesktopChrome>
  );
}

function DesktopTrade({ onStaff }: { onStaff: () => void }) {
  const path = usePath();
  const [theme, toggleTheme] = useTheme();
  const [phase, setPhase] = useState<DesktopPhase>({ kind: "boot" });
  const [data, setData] = useState<Data | null>(null);
  const [info, setInfo] = useState<{ deviceId: string | null; version: string; activeProfileId: string; accounts: DesktopAccount[] }>({ deviceId: null, version: "", activeProfileId: "", accounts: [] });
  const [offline, setOffline] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadLocal = useCallback(async () => {
    setData(await portal.dashboard());
  }, []);

  const [notice, setNotice] = useState<string | null>(null);
  const bootRef = useRef<(notice?: string, splash?: string) => Promise<void>>(async () => undefined);
  const removedNotice = "A trade account was removed from this computer because it no longer exists on the web portal.";

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await desktop.sync();
      setOffline(false);
      await loadLocal();
      setPhase({ kind: "ready" });
    } catch (e) {
      const a = e as ApiError;
      if (a.code === "APP_LOCKED" || a.message === "APP_LOCKED") {
        await bootRef.current();
      } else if (a.code === "ACCOUNT_SECURITY_LOCK" || a.code === "TAMPER_DETECTED") {
        setPhase({ kind: "locked", state: "LOCKED_TAMPER" });
      } else if (a.code === "DEVICE_REVOKED") {
        // The engine has already dropped that profile; start again on whatever account remains.
        await bootRef.current(removedNotice);
      } else if (a.code === "ACCOUNT_SUSPENDED") {
        setPhase({ kind: "suspended" });
      } else if (a.code === "UPDATE_REQUIRED") {
        setPhase({ kind: "update" });
      } else {
        // Offline (or cloud unavailable): fall back to the local cache when there is one.
        setOffline(true);
        try {
          await loadLocal();
          setPhase({ kind: "ready" });
        } catch {
          setPhase({ kind: "offline-empty" });
        }
      }
    } finally {
      setSyncing(false);
    }
  }, [loadLocal]);

  const boot = useCallback(async (bootNotice?: string, splash?: string) => {
    setPhase({ kind: "boot", text: splash });
    setData(null);
    if (bootNotice) setNotice(bootNotice);
    let s: Awaited<ReturnType<typeof desktop.state>>;
    try {
      s = await desktop.state();
    } catch {
      setPhase({ kind: "service-down" });
      return;
    }
    const before = info.accounts.filter((x) => x.enrolled).length;
    const after = s.accounts.filter((x) => x.enrolled).length;
    if (before > after && !bootNotice) setNotice(removedNotice);
    setInfo({ deviceId: s.deviceId, version: s.version, activeProfileId: s.activeProfileId, accounts: s.accounts });
    if (s.locked && s.enrolled) {
      setPhase({ kind: "app-locked", owner: s.owner });
      return;
    }
    if (!s.enrolled) setPhase({ kind: "enroll", notice: bootNotice ?? undefined });
    else await sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync]);
  bootRef.current = boot;

  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = async (id: string) => {
    setPhase({ kind: "boot" });
    try {
      await desktop.activateAccount(id);
    } catch {
      setNotice("That trade account is no longer available on this computer.");
    }
    await boot();
  };
  const others = info.accounts.filter((x) => x.enrolled && x.id !== info.activeProfileId);

  switch (phase.kind) {
    case "boot":
      return <Splash text={phase.text ?? "Verifying this install and syncing…"} />;
    case "app-locked":
      return <AppLockScreen owner={phase.owner} onUnlocked={() => void boot(undefined, "Unlocking DROPLET…")} onRevoked={() => void boot(removedNotice)} />;
    case "service-down":
      return <Problem title="DROPLET couldn't start its local service" body="Close DROPLET and open it again. If this keeps happening, reinstall the latest version from the web portal." action={{ label: "Try again", run: () => void boot() }} />;
    case "enroll":
      return <DesktopGate notice={phase.notice ?? notice} onEnrolled={() => { setNotice(null); void boot(); }} onStaff={onStaff} />;
    case "locked":
      return <LockScreen state={phase.state} token={null} desktop onRetry={() => void boot()} />;
    case "suspended":
      return (
        <Problem
          title="This trade account is suspended"
          body={others.length ? "Ordering is paused for this account. Switch to another account on this computer, or contact your account manager." : "Ordering is paused for this account. Contact your account manager to restore access."}
          action={others.length ? { label: `Switch to ${others[0]!.legalName ?? others[0]!.label}`, run: () => void switchTo(others[0]!.id) } : { label: "Try again", run: () => void boot() }}
        />
      );
    case "update":
      return <Problem title="Update required" body="This version of DROPLET has been withdrawn. Download the current installer from the web portal." />;
    case "offline-empty":
      return <Problem title="Connection required" body="Connect to the internet to complete the first sync." action={{ label: "Try again", run: () => void boot() }} />;
    case "add-account":
      return <DesktopGate addAccount onCancel={() => setPhase(data ? { kind: "ready" } : { kind: "boot" })} onEnrolled={() => void boot()} />;
    case "ready":
      if (!data) return <Splash />;
      return (
        <>
          {notice && (
            <div className="mx-auto max-w-[1440px] px-4 pt-3 sm:px-6 lg:px-8">
              <div className="glass flex items-center gap-3 px-4 py-2.5 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warn" />
                <span className="min-w-0 flex-1">{notice}</span>
                <button className="text-xs font-medium text-muted hover:text-ink" onClick={() => setNotice(null)}>Dismiss</button>
              </div>
            </div>
          )}
          <Dashboard
            data={data}
            reload={async () => {
              await loadLocal();
            }}
            theme={theme}
            path={path}
            onToggleTheme={toggleTheme}
            desktopCtx={{
              ...info,
              offline,
              syncing,
              onSync: () => void sync(),
              onAddAccount: () => setPhase({ kind: "add-account" }),
              onLock: () => {
                void (async () => {
                  setPhase({ kind: "boot", text: "Locking DROPLET…" });
                  try {
                    await desktop.lock();
                    const s = await desktop.state();
                    setData(null);
                    setPhase({ kind: "app-locked", owner: s.owner });
                  } catch {
                    await boot();
                  }
                })();
              },
              onSwitchAccount: (id) => void switchTo(id),
              onRemoveAccount: (id) => {
                void (async () => {
                  setPhase({ kind: "boot" });
                  await desktop.removeAccount(id).catch(() => undefined);
                  await boot();
                })();
              },
            }}
          />
        </>
      );
  }
}

export function Root() {
  return isDesktop ? <DesktopRoot /> : <WebRoot />;
}
