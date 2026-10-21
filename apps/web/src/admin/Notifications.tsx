import { Bell, Building2, FileText, KeyRound, Laptop, PackageCheck, ShieldAlert, UserPlus, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isDesktop } from "../lib/api";
import { admin, type Notice } from "../lib/admin";
import { relative } from "../lib/format";
import { navigate } from "../lib/nav";

const icons: Record<Notice["kind"], LucideIcon> = {
  application: Building2,
  order: PackageCheck,
  approval: KeyRound,
  quote: FileText,
  security: ShieldAlert,
  people: UserPlus,
  device: Laptop,
};
const tone: Record<Notice["kind"], string> = {
  application: "bg-accent/12 text-accent",
  order: "bg-ok/12 text-ok",
  approval: "bg-warn/15 text-warn",
  quote: "bg-accent/12 text-accent",
  security: "bg-danger/12 text-danger",
  people: "bg-ok/12 text-ok",
  device: "bg-muted/15 text-muted",
};

/**
 * Admin notifications: a bell with an unread badge and a dropdown feed, plus toasts as events
 * arrive. Web uses a live Server-Sent Events stream; the desktop app polls every 15 seconds
 * (its cloud proxy handles single requests, not long-lived streams).
 */
export function useNotifications(onNotice?: (n: Notice) => void) {
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const latest = useRef<string | null>(null);
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;

  const known = useRef(new Set<string>());
  const arrive = useCallback((fresh: Notice[]) => {
    const added = fresh.filter((f) => !known.current.has(f.id));
    if (!added.length) return;
    added.forEach((n) => known.current.add(n.id));
    setItems((prev) => [...added, ...prev].slice(0, 30));
    setUnread((u) => u + added.length);
    setToasts((t) => [...added.slice(0, 3), ...t].slice(0, 3));
    added.forEach((n) => {
      onNoticeRef.current?.(n);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 7000);
    });
  }, []);

  useEffect(() => {
    let stop = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    void admin
      .notifications()
      .then((r) => {
        if (stop) return;
        r.items.forEach((n) => known.current.add(n.id));
        setItems(r.items);
        setUnread(r.unread);
        latest.current = r.latestId;
        const poll = () =>
          void admin
            .notifications(latest.current)
            .then((p) => {
              if (p.latestId) latest.current = p.latestId;
              arrive([...p.items].reverse());
            })
            .catch(() => undefined);
        if (isDesktop || typeof EventSource === "undefined") {
          timer = setInterval(poll, 15_000);
          return;
        }
        source = new EventSource("/v1/admin/notifications/stream", { withCredentials: true });
        source.addEventListener("notice", (e) => {
          const n = JSON.parse((e as MessageEvent).data) as Notice;
          latest.current = n.id;
          arrive([n]);
        });
        source.addEventListener("signed-out", () => source?.close());
        // If the stream can't be held open (strict proxy), fall back to polling.
        source.onerror = () => {
          if (source?.readyState === EventSource.CLOSED && !timer) timer = setInterval(poll, 15_000);
        };
      })
      .catch(() => undefined);

    return () => {
      stop = true;
      source?.close();
      if (timer) clearInterval(timer);
    };
  }, [arrive]);

  const markSeen = useCallback(() => {
    setUnread(0);
    void admin.notificationsSeen().catch(() => undefined);
  }, []);
  const dismiss = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));
  return { items, unread, toasts, markSeen, dismiss };
}

function Row({ n, onOpen }: { n: Notice; onOpen: (n: Notice) => void }) {
  const Icon = icons[n.kind];
  return (
    <button onClick={() => onOpen(n)} className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-surface/70">
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tone[n.kind]}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{n.title}</span>
        <span className="block truncate text-xs text-muted">{n.body}</span>
      </span>
      <span className="shrink-0 text-[11px] text-muted">{relative(n.at)}</span>
    </button>
  );
}

export function NotificationBell({ state }: { state: ReturnType<typeof useNotifications> }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 10, right: Math.max(window.innerWidth - r.right, 8) });
    };
    place();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const go = (n: Notice) => {
    setOpen(false);
    navigate(n.link);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open && state.unread) state.markSeen();
        }}
        className="relative grid h-9 w-9 place-items-center rounded-full border border-line/70 bg-surface/60 transition hover:bg-surface dark:border-line/[0.07]"
        aria-label={state.unread ? `Notifications, ${state.unread} unread` : "Notifications"}
        title="Notifications"
      >
        <Bell className="h-4 w-4" />
        {state.unread > 0 && (
          <span className="num absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-surface">
            {state.unread > 99 ? "99+" : state.unread}
          </span>
        )}
      </button>
      {open && pos && createPortal(
        // Rendered at the page root: inside the blurred sticky header, Chrome let the page
        // bleed through even an opaque menu.
        <div ref={panel} style={{ top: pos.top, right: pos.right }} className="glass-float fixed z-[70] rounded-2xl w-[min(24rem,calc(100vw-2rem))] p-2" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
            <span className="text-sm font-semibold">Notifications</span>
            <span className="text-[11px] text-muted">{isDesktop ? "Checks every 15 s" : "Live"}</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {state.items.length === 0 ? (
              <p className="px-2.5 py-8 text-center text-sm text-muted">Nothing yet. New applications, orders and quotes show up here.</p>
            ) : (
              state.items.map((n) => <Row key={n.id} n={n} onOpen={go} />)
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function NoticeToasts({ state }: { state: ReturnType<typeof useNotifications> }) {
  if (!state.toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {state.toasts.map((n) => {
        const Icon = icons[n.kind];
        return (
          <div key={n.id} className="glass-float pointer-events-auto flex rounded-2xl items-start gap-3 p-3 shadow-dock">
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tone[n.kind]}`}>
              <Icon className="h-4 w-4" />
            </span>
            <button className="min-w-0 flex-1 text-left" onClick={() => { state.dismiss(n.id); navigate(n.link); }}>
              <span className="block text-sm font-semibold">{n.title}</span>
              <span className="block text-xs text-muted">{n.body}</span>
            </button>
            <button className="text-muted hover:text-ink" aria-label="Dismiss" onClick={() => state.dismiss(n.id)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
