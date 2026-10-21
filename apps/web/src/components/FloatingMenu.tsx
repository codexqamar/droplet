import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Dropdown rendered at the page root and positioned under its anchor. Menus nested inside the
 * blurred sticky header let page content bleed through in Chrome, so they live outside it.
 * Closes on outside click, Escape, and keeps its position on scroll/resize.
 */
export function FloatingMenu({ anchor, open, onClose, children, className = "", label }: {
  anchor: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 8, right: Math.max(window.innerWidth - r.right, 8) });
    };
    place();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, onClose]);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={panel} role="menu" aria-label={label} style={{ top: pos.top, right: pos.right }} className={`glass-float fixed z-[70] rounded-2xl ${className}`}>
      {children}
    </div>,
    document.body,
  );
}
