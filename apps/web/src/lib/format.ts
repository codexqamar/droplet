const formatters = new Map<string, Intl.NumberFormat>();

export function money(minor: number, currency = "GBP"): string {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-GB", { style: "currency", currency });
    formatters.set(currency, f);
  }
  return f.format(minor / 100);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function relative(iso: string, now = Date.now()): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function daysUntil(iso: string, now = Date.now()): number {
  return Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
}
