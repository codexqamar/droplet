import type { Branch, Dashboard, LineItem, OrderList, TeamMember } from "./types";

/**
 * One UI, two transports. The web build talks to the cloud API with a session cookie; the
 * desktop build (VITE_TARGET=desktop) talks to the local engine through the Tauri shell's
 * `daemon_request` proxy, which holds the per-launch secret so the webview never sees it.
 */
export const isDesktop = import.meta.env.VITE_TARGET === "desktop";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail || code);
  }
}

/** Fired when the session ends mid-use (expired, revoked, user deactivated) so the shell can
 * return to sign-in instead of showing raw errors. */
export const SIGNED_OUT_EVENT = "droplet:signed-out";
function noteSignedOut(status: number, path: string) {
  if (status === 401 && !path.startsWith("/v1/auth/") && !path.startsWith("/v1/setup") && !path.startsWith("/v1/invites")) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "DROPLET is unavailable. Try again shortly.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!res.ok) {
    noteSignedOut(res.status, path);
    throw new ApiError(res.status, data.error ?? `HTTP_${res.status}`, data.detail);
  }
  return data as T;
}

async function daemon<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>("daemon_request", { method, path, body: body ?? null });
  } catch (e) {
    // The shell reports failures as "<status>:<body>".
    const raw = String(e);
    const m = raw.match(/^(\d+):([\s\S]*)$/);
    if (!m) throw new ApiError(0, "DAEMON_ERROR", "The desktop service is unavailable. Restart DROPLET and try again.");
    const status = Number(m[1]);
    try {
      const j = JSON.parse(m[2]!) as { error?: string; detail?: unknown };
      const detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? "");
      throw new ApiError(status, j.error ?? detail, detail);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(status, status === 0 ? "OFFLINE" : `HTTP_${status}`, status === 0 ? "DROPLET is offline." : "The request could not be completed.");
    }
  }
}

/**
 * Desktop → cloud API through the shell's `cloud_request` proxy. The shell keeps the session
 * cookie in memory (never in the webview), so staff can use the admin portal from the app.
 */
async function cloud<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>("cloud_request", { method, path, body: body ?? null });
  } catch (e) {
    const raw = String(e);
    const m = raw.match(/^(\d+):([\s\S]*)$/);
    if (!m || m[1] === "0") throw new ApiError(0, "NETWORK", "DROPLET is unavailable. Try again shortly.");
    let j: { error?: string; detail?: string } = {};
    try {
      j = JSON.parse(m[2]!) as typeof j;
    } catch {
      /* non-JSON error body */
    }
    noteSignedOut(Number(m[1]), path);
    throw new ApiError(Number(m[1]), j.error ?? `HTTP_${m[1]}`, j.detail);
  }
}

const call = isDesktop ? daemon : http;
/** Calls that always go to the cloud (auth, admin portal). */
export const cloudCall = isDesktop ? cloud : http;

export interface PlaceOrderResult {
  number: string | null;
  status: string;
  queued?: boolean;
}

export interface DesktopAccount {
  id: string;
  active: boolean;
  enrolled: boolean;
  deviceId: string | null;
  label: string;
  legalName: string | null;
  code: string | null;
  status?: string | null;
}

/** Operations the dashboard needs, identical on both targets. */
export const portal = {
  dashboard: () => call<Dashboard>("GET", isDesktop ? "/v1/dashboard" : "/v1/portal/dashboard"),
  placeOrder: (lines: LineItem[], poNumber: string | undefined, mode: "submit" | "draft" = "submit") =>
    call<PlaceOrderResult>("POST", "/v1/orders", { lines, poNumber: poNumber || undefined, mode }),
  requestQuote: (lines: LineItem[], notes?: string) => call<{ number: string }>("POST", "/v1/quotes", { lines, notes }),
};

/** Web-only trade portal features (the desktop engine works offline and does not carry these). */
export const trade = {
  stock: () => http<{ at: string; items: Array<{ sku: string; stock: number; leadTimeDays: number; branches: Branch[] }> }>("GET", "/v1/portal/stock"),
  lists: () => http<{ lists: OrderList[] }>("GET", "/v1/portal/lists"),
  createList: (name: string, lines: LineItem[], note?: string | null) => http<{ id: string }>("POST", "/v1/portal/lists", { name, note: note ?? null, lines }),
  updateList: (id: string, name: string, lines: LineItem[], note?: string | null) => http<{ ok: true }>("PUT", `/v1/portal/lists/${id}`, { name, note: note ?? null, lines }),
  deleteList: (id: string) => http<{ ok: true }>("DELETE", `/v1/portal/lists/${id}`),
  listUsed: (id: string) => http<{ ok: true }>("POST", `/v1/portal/lists/${id}/used`, {}),
  team: () => http<{ users: TeamMember[]; invites: Array<{ id: string; email: string; expiresAt: string }> }>("GET", "/v1/portal/team"),
  inviteColleague: (email: string, fullName?: string) => http<{ inviteUrl: string }>("POST", "/v1/portal/team/invites", { email, fullName }),
  updateMember: (id: string, body: { canApprove?: boolean; spendLimitMinor?: number | null; active?: boolean }) => http<{ ok: true }>("PATCH", `/v1/portal/team/${id}`, body),
  approveOrder: (number: string, action: "approve" | "reject") => http<{ number: string; status: string }>("POST", `/v1/portal/orders/${encodeURIComponent(number)}/${action}`, {}),
  startPayment: (amountMinor: number, reference: string) => http<{ id: string; url: string }>("POST", "/v1/portal/payments", { amountMinor, reference }),
  payment: (id: string) => http<{ id: string; status: string; amountMinor: number; currency: string; reference: string; provider: string; method: string | null }>("GET", `/v1/portal/payments/${id}`),
  demoComplete: (id: string, method: "card" | "bacs_debit", cancel?: boolean) => http<{ status: string }>("POST", `/v1/portal/payments/${id}/demo-complete`, { method, cancel }),
};

export interface Me {
  user: { name: string; email: string; role: "TRADE_CUSTOMER" | "SALES_REP" | "ADMIN" };
  staff: boolean;
  mfaEnabled: boolean;
  accountCode: string | null;
}

export const auth = {
  me: () => cloudCall<Me>("GET", "/v1/auth/me"),
  login: (email: string, password: string, totp?: string) =>
    cloudCall<{ ok?: true; mfaRequired?: true; role?: Me["user"]["role"] }>("POST", "/v1/auth/login", { email, password, totp }),
  logout: () => cloudCall<{ ok: true }>("POST", "/v1/auth/logout"),
  apply: (body: { companyName: string; fullName: string; email: string; phone?: string; password: string }) =>
    http<{ ok: true }>("POST", "/v1/auth/apply", body),
  mfaSetup: () => cloudCall<{ otpauthUri: string }>("POST", "/v1/auth/mfa/setup"),
  mfaConfirm: (code: string) => cloudCall<{ ok: true }>("POST", "/v1/auth/mfa/confirm", { code }),
  profile: () => http<{ name: string; supportEmail: string | null; needsSetup: boolean }>("GET", "/v1/public/profile"),
  setup: (body: { token: string; businessName: string; fullName: string; email: string; password: string }) => http<{ ok: true }>("POST", "/v1/setup", body),
  invite: (token: string) =>
    http<{ email: string; fullName: string | null; role: Me["user"]["role"]; accountName: string | null; business: string }>("GET", `/v1/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, fullName: string, password: string) => http<{ ok: true }>("POST", "/v1/invites/accept", { token, fullName, password }),
  acceptQuote: (number: string) => http<{ number: string; status: string }>("POST", `/v1/quotes/${encodeURIComponent(number)}/accept`, {}),
  downloadGrant: (platform: string) =>
    http<{ url: string; sha256: string; version: string; enrollmentCode: string; expiresInSec: number }>(
      "POST",
      "/v1/desktop/download-grants",
      { platform },
    ),
  recoveryRedeem: (token: string, password: string, mfaCode: string) =>
    http<{ download: { url: string; sha256: string; version: string }; enrollmentCode: string; instructions: string[] }>(
      "POST",
      "/v1/security/recovery/redeem",
      { token, password, mfaCode },
    ),
  recoveryResend: (email: string) => http<{ ok: true }>("POST", "/v1/security/recovery/resend", { email }),
};

export const desktop = {
  state: () =>
    daemon<{ enrolled: boolean; deviceId: string | null; activeProfileId: string; accounts: DesktopAccount[]; build: string; version: string; integrity: string; lastSyncAt: number | null; locked: boolean; owner: { name?: string; email?: string } | null }>(
      "GET",
      "/v1/state",
    ),
  enroll: (enrollmentCode: string, label: string) => daemon<{ deviceId: string }>("POST", "/v1/enroll", { enrollment_code: enrollmentCode, label }),
  addAccount: (enrollmentCode: string, label: string) => daemon<{ deviceId: string }>("POST", "/v1/accounts", { enrollment_code: enrollmentCode, label }),
  activateAccount: (profileId: string) => daemon<{ ok: true }>("POST", "/v1/accounts/activate", { profile_id: profileId }),
  lock: () => daemon<{ locked: true }>("POST", "/v1/lock"),
  unlock: (password: string, totp?: string) => daemon<{ ok?: true; mfaRequired?: true }>("POST", "/v1/unlock", { password, totp: totp ?? null }),
  removeAccount: (profileId: string) => daemon<{ ok: true }>("DELETE", `/v1/accounts/${encodeURIComponent(profileId)}`),
  sync: () => daemon<{ pulled: number; lastSyncAt: number }>("POST", "/v1/sync"),
};
