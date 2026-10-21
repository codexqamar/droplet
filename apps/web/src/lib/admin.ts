import { cloudCall } from "./api";

/** Admin portal client. Same calls on web (cookie) and desktop (shell cloud proxy). */

export type Role = "TRADE_CUSTOMER" | "SALES_REP" | "ADMIN";
export type AccountStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "SUSPENDED";
export type OrderStatus = "DRAFT" | "PENDING_APPROVAL" | "SUBMITTED" | "CONFIRMED" | "PART_SHIPPED" | "SHIPPED" | "INVOICED" | "CANCELLED";
export type QuoteStatus = "REQUESTED" | "IN_REVIEW" | "OFFERED" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export interface Overview {
  business: string;
  currency: string;
  me: { id: string; name: string; email: string; role: Role };
  counts: { pendingApplications: number; activeAccounts: number; ordersAwaitingApproval: number; openOrders: number; openQuotes: number; openIncidents: number };
  activity: Array<{ id: string; action: string; actor: string; target: string | null; at: string }>;
}

export interface AccountRow {
  id: string;
  code: string;
  legalName: string;
  phone: string | null;
  status: AccountStatus;
  statusReason: string | null;
  securityState: string;
  tier: string | null;
  priceTierId: string | null;
  creditLimitMinor: number;
  paymentTermsDays: number;
  currency: string;
  balanceMinor: number;
  rep: { id: string; name: string } | null;
  owner: { name: string; email: string } | null;
  users: number;
  orders: number;
  createdAt: string;
  approvedAt: string | null;
}

export interface AccountDetail {
  account: AccountRow;
  users: Array<{ id: string; name: string; email: string; owner: boolean; active: boolean; lastLoginAt: string | null }>;
  pendingInvites: Array<{ id: string; email: string; expiresAt: string }>;
  prices: Array<{ id: string; sku: string; name: string; minQty: number; unitMinor: number; listMinor: number; validTo: string | null }>;
  ledger: Array<{ id: string; kind: string; reference: string; amountMinor: number; postedAt: string; dueAt: string | null }>;
  devices: Array<{ id: string; label: string; user: string; status: string; version: string; lastAttestedAt: string | null }>;
}

export interface AdminOrder {
  number: string;
  account: { id: string; code: string; name: string };
  poNumber: string | null;
  channel: "WEB" | "DESKTOP" | "REP";
  placedBy: string;
  placedAt: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  next: OrderStatus[];
  lines: Array<{ sku: string; name: string; qty: number; unitMinor: number; lineMinor: number; source: string }>;
}

export interface AdminQuote {
  number: string;
  account: { id: string; code: string; name: string };
  requestedBy: string;
  status: QuoteStatus;
  notes: string | null;
  validUntil: string | null;
  createdAt: string;
  currency: string;
  lines: Array<{ id: string; sku: string; name: string; qty: number; listMinor: number; offeredMinor: number | null }>;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  uom: string;
  packSize: number;
  listMinor: number;
  stock: number;
  active: boolean;
  tierPrices: Array<{ tierId: string; minQty: number; unitMinor: number }>;
}

export interface Tier {
  id: string;
  name: string;
  accounts: number;
}

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mfa: boolean;
  accounts: number;
  lastLoginAt: string | null;
}

export interface SecurityData {
  devices: Array<{ id: string; label: string; user: string; account: string; status: string; version: string; lastAttestedAt: string | null; createdAt: string }>;
  incidents: Array<{ id: string; account: { id: string; name: string; state: string }; kind: string; openedAt: string; resolvedAt: string | null }>;
  releases: Array<{ id: string; buildId: string; version: string; platform: string; publishedAt: string; revokedAt: string | null; devices: number }>;
}

export type Terms = { priceTierId?: string | null; creditLimitMinor?: number; paymentTermsDays?: number; repId?: string | null; legalName?: string; phone?: string | null };

const qs = (p: Record<string, string | undefined>) => {
  const e = Object.entries(p).filter(([, v]) => v);
  return e.length ? `?${new URLSearchParams(e as [string, string][]).toString()}` : "";
};
const get = <T,>(path: string) => cloudCall<T>("GET", path);
const post = <T = { ok: true },>(path: string, body: unknown = {}) => cloudCall<T>("POST", path, body);

export interface Notice {
  id: string;
  kind: "application" | "order" | "approval" | "quote" | "security" | "people" | "device";
  title: string;
  body: string;
  link: string;
  at: string;
}

export const admin = {
  notifications: (after?: string | null) => get<{ items: Notice[]; unread: number; latestId: string | null }>(`/v1/admin/notifications${qs({ after: after ?? undefined })}`),
  notificationsSeen: () => post("/v1/admin/notifications/seen"),
  accountCatalogue: (id: string) => get<{ catalogue: import("./types").CatalogueItem[] }>(`/v1/admin/accounts/${id}/catalogue`),
  orderForAccount: (id: string, lines: Array<{ sku: string; qty: number }>, poNumber: string | undefined, mode: "submit" | "draft") =>
    post<{ number: string; status: string; totalMinor: number }>(`/v1/admin/accounts/${id}/orders`, { lines, poNumber: poNumber || undefined, mode }),
  overview: () => get<Overview>("/v1/admin/overview"),
  accounts: (status?: string, q?: string) => get<{ accounts: AccountRow[] }>(`/v1/admin/accounts${qs({ status, q })}`),
  account: (id: string) => get<AccountDetail>(`/v1/admin/accounts/${id}`),
  approve: (id: string, terms: Terms) => post(`/v1/admin/accounts/${id}/approve`, terms),
  setStatus: (id: string, action: "reject" | "suspend" | "reactivate", reason?: string) => post(`/v1/admin/accounts/${id}/${action}`, { reason }),
  updateAccount: (id: string, terms: Terms) => cloudCall<{ ok: true }>("PATCH", `/v1/admin/accounts/${id}`, terms),
  createAccount: (body: Terms & { legalName: string; ownerName: string; ownerEmail: string }) => post<{ id: string; code: string; inviteUrl: string }>("/v1/admin/accounts", body),
  inviteBuyer: (id: string, email: string, fullName?: string) => post<{ inviteUrl: string }>(`/v1/admin/accounts/${id}/invites`, { email, fullName }),
  setContractPrice: (id: string, body: { sku: string; minQty: number; unitMinor: number }) => post(`/v1/admin/accounts/${id}/prices`, body),
  removeContractPrice: (priceId: string) => cloudCall<{ ok: true }>("DELETE", `/v1/admin/prices/${priceId}`),
  postLedger: (id: string, body: { kind: string; reference: string; amountMinor: number; increase?: boolean }) => post(`/v1/admin/accounts/${id}/ledger`, body),
  unlock: (id: string, reason: string) => post(`/v1/admin/accounts/${id}/unlock`, { reason }),
  orders: (status?: string, q?: string) => get<{ orders: AdminOrder[] }>(`/v1/admin/orders${qs({ status, q })}`),
  setOrderStatus: (number: string, status: OrderStatus) => post(`/v1/admin/orders/${encodeURIComponent(number)}/status`, { status }),
  quotes: (status?: string) => get<{ quotes: AdminQuote[] }>(`/v1/admin/quotes${qs({ status })}`),
  offerQuote: (number: string, validDays: number, lines: Array<{ id: string; offeredMinor: number }>) => post(`/v1/admin/quotes/${encodeURIComponent(number)}/offer`, { validDays, lines }),
  quoteAction: (number: string, action: "review" | "decline") => post(`/v1/admin/quotes/${encodeURIComponent(number)}/${action}`),
  products: () => get<{ products: Product[]; tiers: Tier[] }>("/v1/admin/products"),
  createProduct: (body: Omit<Product, "id" | "tierPrices">) => post<{ id: string }>("/v1/admin/products", body),
  updateProduct: (id: string, body: Partial<Omit<Product, "id" | "sku" | "tierPrices">>) => cloudCall<{ ok: true }>("PATCH", `/v1/admin/products/${id}`, body),
  createTier: (name: string) => post<{ id: string }>("/v1/admin/tiers", { name }),
  setTierPrices: (productId: string, tierId: string, breaks: Array<{ minQty: number; unitMinor: number }>) => cloudCall<{ ok: true }>("PUT", `/v1/admin/products/${productId}/tier-prices`, { tierId, breaks }),
  team: () => get<{ staff: StaffMember[]; invites: Array<{ id: string; email: string; role: Role; expiresAt: string }> }>("/v1/admin/team"),
  reps: () => get<{ reps: Array<{ id: string; name: string; role: Role }> }>("/v1/admin/reps"),
  inviteStaff: (email: string, role: "ADMIN" | "SALES_REP", fullName?: string) => post<{ inviteUrl: string }>("/v1/admin/team/invites", { email, role, fullName }),
  revokeInvite: (id: string) => cloudCall<{ ok: true }>("DELETE", `/v1/admin/invites/${id}`),
  resetMfa: (id: string) => post(`/v1/admin/users/${id}/reset-mfa`),
  setUserActive: (id: string, active: boolean) => post(`/v1/admin/users/${id}/${active ? "reactivate" : "deactivate"}`),
  security: () => get<SecurityData>("/v1/admin/security"),
  revokeDevice: (id: string) => post(`/v1/admin/devices/${id}/revoke`),
  revokeRelease: (id: string) => post(`/v1/admin/releases/${id}/revoke`),
  settings: () => get<{ name: string; supportEmail: string | null; currency: string }>("/v1/admin/settings"),
  updateSettings: (body: { name?: string; supportEmail?: string | null; currency?: string }) => cloudCall<{ ok: true }>("PATCH", "/v1/admin/settings", body),
  audit: () => get<{ entries: Array<{ id: string; at: string; actor: string; role: Role | null; action: string; target: string | null; ip: string | null }> }>("/v1/admin/audit"),
};

/** "12.50" → 1250. Returns null for anything that is not a non-negative amount. */
export function parseMoney(input: string): number | null {
  const t = input.replace(/[^\d.]/g, "");
  if (!t || !/^\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export const toMoneyInput = (minor: number) => (minor / 100).toFixed(2);
