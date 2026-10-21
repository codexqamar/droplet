import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function StatCard({
  icon: Icon,
  label,
  value,
  foot,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  badge?: string;
}) {
  return (
    <div className="glass relative flex min-h-[132px] flex-col justify-between overflow-hidden p-5">
      <div className="flex items-start justify-between">
        <span className="glass-inset grid h-10 w-10 place-items-center rounded-xl">
          <Icon className="h-5 w-5" strokeWidth={1.7} />
        </span>
        {badge && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-onaccent">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{label}</div>
          {foot && <div className="mt-0.5 text-xs text-muted">{foot}</div>}
        </div>
        <div className="num text-[28px] font-semibold leading-none tracking-tight">{value}</div>
      </div>
    </div>
  );
}
