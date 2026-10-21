import { join } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// In production the portal address must be explicit: it drives cookie security (Secure on
// https), CSRF origin checks and every link in emails (setup, invites, recovery, downloads).
if (process.env.NODE_ENV === "production" && !process.env.PORTAL_ORIGIN) {
  throw new Error("PORTAL_ORIGIN must be set in production (e.g. https://portal.example.com)");
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // Origin browsers use to reach the API (the portal proxies /v1 in dev, so they share one).
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? process.env.PORTAL_ORIGIN ?? "http://localhost:5173",
  portalOrigin: process.env.PORTAL_ORIGIN ?? "http://localhost:5173",
  /** HMAC key for download URLs, enrollment codes and sync tokens. Rotate via KMS. */
  signingSecret: required("DROPLET_SIGNING_SECRET"),
  /** 32-byte hex AES-256-GCM key for MFA secrets at rest (from KMS in production). */
  mfaEncKeyHex: required("DROPLET_MFA_ENC_KEY"),

  /** Built web portal served on the same origin. Docker sets WEB_DIST_DIR. */
  webDistDir: process.env.WEB_DIST_DIR ?? join(import.meta.dirname, "..", "..", "web", "dist"),
  /** Signed desktop installers. In Docker this is a persistent volume (RELEASES_DIR). */
  releasesDir: process.env.RELEASES_DIR ?? join(import.meta.dirname, "..", "releases"),
  /** Bearer token for the release-upload endpoint used by the desktop build. Unset = disabled. */
  opsToken: process.env.DROPLET_OPS_TOKEN ?? "",
  /** Max installer upload size (bytes). */
  maxReleaseBytes: Number(process.env.MAX_RELEASE_BYTES ?? 300 * 1024 * 1024),

  nonceTtlSec: 60,
  attestationClockSkewSec: 120,
  syncTokenTtlSec: 10 * 60,
  downloadUrlTtlSec: 10 * 60,
  downloadGrantTtlSec: 60 * 60,
  enrollmentCodeTtlSec: 60 * 60,
  recoveryTokenTtlSec: 30 * 60,
  certificateTtlDays: 90,
} as const;
