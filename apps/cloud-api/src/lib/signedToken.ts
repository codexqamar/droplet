import { config } from "../config.js";
import { hmacSign, safeEqual } from "./crypto.js";

/**
 * Compact HMAC-signed tokens: `<purpose>.<b64url(json)>.<b64url(hmac)>`.
 * The purpose prefix is part of the MAC input, so a token minted for one purpose
 * (e.g. enrollment) can never be replayed as another (e.g. sync).
 */
export type TokenPurpose = "enroll" | "sync" | "dl" | "art";

export function mintToken<T extends object>(purpose: TokenPurpose, claims: T, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  return `${purpose}.${body}.${hmacSign(config.signingSecret, `${purpose}.${body}`)}`;
}

export function readToken<T extends object>(purpose: TokenPurpose, token: string): (T & { exp: number }) | null {
  const [p, body, sig] = token.split(".");
  if (p !== purpose || !body || !sig) return null;
  if (!safeEqual(sig, hmacSign(config.signingSecret, `${p}.${body}`))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
}
