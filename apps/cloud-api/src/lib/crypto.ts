import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace.
 * Must stay byte-identical with `canonical_json()` in the desktop daemon and
 * `serde_json::to_string(&BTreeMap)` in the Tauri shell, otherwise signatures fail.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

// DER prefix for an Ed25519 SubjectPublicKeyInfo; lets us import a raw 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519KeyFromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function verifyEd25519(publicKeyRawB64: string, message: string, signatureB64: string): boolean {
  try {
    return verify(null, Buffer.from(message, "utf8"), ed25519KeyFromRaw(publicKeyRawB64), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function hmacSign(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
