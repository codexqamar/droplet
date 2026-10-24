import { BookOpen, FileText, LayoutGrid, ListChecks, Receipt, ShoppingBag, Users, Zap, type LucideIcon } from "lucide-react";

export type PortalPage = "dashboard" | "quick-order" | "catalogue" | "lists" | "orders" | "quotes" | "statements" | "team";

export const dockItems: Array<{ id: PortalPage; label: string; icon: LucideIcon; webOnly?: boolean }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "quick-order", label: "Quick order", icon: Zap },
  { id: "catalogue", label: "Catalogue", icon: BookOpen },
  { id: "lists", label: "Lists", icon: ListChecks, webOnly: true },
  { id: "orders", label: "Orders", icon: ShoppingBag },
  { id: "quotes", label: "Quotes", icon: FileText },
  { id: "statements", label: "Statements", icon: Receipt },
  { id: "team", label: "Team", icon: Users, webOnly: true },
];

export function Dock({ active, onSelect, web = true }: { active: PortalPage; onSelect: (id: PortalPage) => void; web?: boolean }) {
  return (
    <nav aria-label="Portal" className="fixed inset-x-0 bottom-3 z-30 flex justify-center px-3 pb-[env(safe-area-inset-bottom)]">
      <ul className="glass dock-material flex max-w-full gap-1 overflow-x-auto rounded-[22px] p-1.5 shadow-dock">
        {dockItems.filter((i) => web || !i.webOnly).map(({ id, label, icon: Icon }) => {
          const selected = id === active;
          return (
            <li key={id}>
              <button onClick={() => onSelect(id)} aria-current={selected ? "page" : undefined} className={`dock-item ${selected ? "dock-item--active" : ""}`}>
                <span className="dock-item__icon"><Icon className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
