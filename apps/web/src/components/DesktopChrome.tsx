import { Droplet, Maximize2, Minus, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function DesktopChrome({ children, context = "Trade desktop", onAdmin }: { children: ReactNode; context?: string; onAdmin?: () => void }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow.onResized(async () => setMaximized(await appWindow.isMaximized())).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  const windowAction = (action: "minimize" | "maximize" | "close") => {
    const appWindow = getCurrentWindow();
    if (action === "minimize") void appWindow.minimize();
    if (action === "maximize") void appWindow.toggleMaximize();
    if (action === "close") void appWindow.close();
  };

  return (
    <div className={`desktop-frame ${maximized ? "desktop-frame--maximized" : ""}`}>
      <header className="desktop-titlebar" data-tauri-drag-region onDoubleClick={() => windowAction("maximize")}>
        <div className="desktop-titlebar__brand" data-tauri-drag-region>
          <span className="desktop-titlebar__mark"><Droplet className="h-3.5 w-3.5 fill-current" /></span>
          <span data-tauri-drag-region>DROPLET</span>
          <span className="desktop-titlebar__context" data-tauri-drag-region>{context}</span>
        </div>
        <div className="desktop-titlebar__controls">
          {onAdmin && (
            <button type="button" onClick={onAdmin} aria-label="Staff sign-in: admin portal" title="Admin portal (staff)">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          <button type="button" onClick={() => windowAction("minimize")} aria-label="Minimize window" title="Minimize">
            <Minus className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button type="button" onClick={() => windowAction("maximize")} aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"}>
            <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button type="button" className="desktop-titlebar__close" onClick={() => windowAction("close")} aria-label="Close window" title="Close">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className="desktop-content">{children}</div>
    </div>
  );
}
