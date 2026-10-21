import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { Tx } from "../db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/** Password hashes are stored as `scrypt$N$r$p$saltB64$hashB64`. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const [N, r, p] = [16384, 8, 1];
  const hash = await scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function encryptSecret(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config.mfaEncKeyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function otpauthUri(email: string, secret: Buffer): string {
  return `otpauth://totp/DROPLET:${encodeURIComponent(email)}?secret=${base32(secret)}&issuer=DROPLET&algorithm=SHA1&digits=6&period=30`;
}

/** MFA secrets at rest: 12-byte IV || 16-byte GCM tag || ciphertext. */
export function decryptSecret(blob: Uint8Array): Buffer {
  const buf = Buffer.from(blob);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(config.mfaEncKeyHex, "hex"), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

/** Current code for a raw secret (dev tooling only). */
export function totpNow(secret: Buffer, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", secret).update(counter).digest();
  const off = h[h.length - 1]! & 0x0f;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** RFC 6238 TOTP (SHA-1, 30s, 6 digits) with ±1 step tolerance. */
export function totpMatches(secret: Buffer, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(now / 1000 / 30);
  for (const drift of [-1, 0, 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step + drift));
    const h = createHmac("sha1", secret).update(counter).digest();
    const off = h[h.length - 1]! & 0x0f;
    const bin = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
    if (timingSafeEqual(Buffer.from(bin.toString().padStart(6, "0")), Buffer.from(code))) return true;
  }
  return false;
}

/**
 * Verifies a TOTP code against any of the user's TOTP factors.
 * WebAuthn assertions are verified by the portal's WebAuthn route and are not handled here.
 */
export async function verifyTotp(tx: Tx, userId: string, code: string): Promise<boolean> {
  const factors = await tx.mfaFactor.findMany({ where: { userId, kind: "TOTP", confirmedAt: { not: null } } });
  for (const f of factors) {
    if (totpMatches(decryptSecret(f.secretEnc), code)) {
      await tx.mfaFactor.update({ where: { id: f.id }, data: { lastUsedAt: new Date() } });
      return true;
    }
  }
  return false;
}
