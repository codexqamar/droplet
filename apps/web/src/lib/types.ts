/** Shapes mirror the cloud API read models in apps/cloud-api/src/portalData.ts (money = minor units). */

export type PriceSource = "ACCOUNT" | "TIER" | "LIST";
export type OrderStatus =
  | "DRAFT"
  | "AWAITING_BUYER_APPROVAL"
  | "PENDING_APPROVAL"
  | "SUBMITTED"
  | "CONFIRMED"
  | "PART_SHIPPED"
  | "SHIPPED"
  | "INVOICED"
  | "CANCELLED";
export type SecurityState = "ACTIVE" | "LOCKED_TAMPER" | "RECOVERY_PENDING" | "RECOVERY_VERIFIED" | "AWAITING_CLEAN_INSTALL";

export interface CatalogueItem {
  sku: string;
  name: string;
  uom: string;
  packSize: number;
  listMinor: number;
  stock: number;
  /** Supplier lead time when out of stock (web; the desktop cache may not carry it). */
  leadTimeDays?: number;
  barcode?: string | null;
  /** Availability per warehouse / branch. */
  branches?: Branch[];
  /** Negotiated price breaks for this account, ascending by minQty. */
  breaks: Array<{ minQty: number; unitMinor: number; source: PriceSource }>;
}

export interface Branch {
  code: string;
  name: string;
  qty: number;
}

export interface LineItem {
  sku: string;
  qty: number;
}

export interface OrderSummary {
  number: string;
  poNumber: string | null;
  placedAt: string;
  channel: "WEB" | "DESKTOP" | "REP";
  placedBy: string;
  lines: number;
  items: LineItem[];
  totalMinor: number;
  status: OrderStatus;
  placedById?: string;
  tracking?: { carrier: string | null; number: string | null; url: string | null; shippedAt: string | null } | null;
}

export interface QuoteSummary {
  number: string;
  status: "REQUESTED" | "IN_REVIEW" | "OFFERED";
  lines: number;
  validUntil: string | null;
  handler: string;
  offeredTotalMinor?: number | null;
}

export interface LedgerLine {
  ref: string;
  kind: "INVOICE" | "CREDIT_NOTE" | "PAYMENT" | "ADJUSTMENT";
  postedAt: string;
  dueAt: string | null;
  amountMinor: number;
}

export interface CreditPosition {
  limitMinor: number;
  balanceMinor: number;
  termsDays: number;
  aging: Array<{ label: string; amountMinor: number }>;
}

export interface DeviceSummary {
  id: string;
  label: string;
  version: string;
  status: "TRUSTED" | "PENDING_ENROLLMENT" | "QUARANTINED" | "RETIRED";
  lastAttestedAt: string | null;
}

export interface AccountContext {
  code: string;
  legalName: string;
  tier: string;
  currency: string;
  securityState: SecurityState;
  user: { name: string; email: string; role: "TRADE_CUSTOMER" | "SALES_REP" | "ADMIN"; initials: string; owner?: boolean; canApprove?: boolean; spendLimitMinor?: number | null };
  rep: { name: string; email: string } | null;
  poRequired?: boolean;
}

export interface PaymentsInfo {
  enabled: boolean;
  provider: "stripe" | "demo" | null;
  methods: string[];
  recent: Array<{ id: string; amountMinor: number; reference: string; status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; method: string | null; at: string }>;
}

export interface OrderList {
  id: string;
  name: string;
  note: string | null;
  createdBy: string;
  updatedAt: string;
  lastUsedAt: string | null;
  items: Array<{ sku: string; name: string; qty: number }>;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  owner: boolean;
  canApprove: boolean;
  spendLimitMinor: number | null;
  active: boolean;
  lastLoginAt: string | null;
}

export interface Dashboard {
  account: AccountContext;
  mfaEnabled: boolean;
  credit: CreditPosition;
  orders: OrderSummary[];
  quotes: QuoteSummary[];
  ledger: LedgerLine[];
  devices: DeviceSummary[];
  catalogue: CatalogueItem[];
  /** Web only: online payment of statement balances. */
  payments?: PaymentsInfo;
  /** Desktop only: epoch ms of the last successful sync. */
  lastSyncAt?: number | null;
}
