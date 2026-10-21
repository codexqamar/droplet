import { HttpError } from "../auth.js";

/**
 * Fixed-window limiter for credential checks (web sign-in, desktop unlock):
 * 8 failures per key per 15 minutes, then 429 until the window ends.
 */
const failures = new Map<string, { count: number; resetAt: number }>();

export function assertNotLimited(key: string): void {
  const f = failures.get(key);
  if (f && f.resetAt > Date.now() && f.count >= 8) throw new HttpError(429, "TOO_MANY_ATTEMPTS");
}

export function recordFailure(key: string): void {
  const f = failures.get(key);
  if (!f || f.resetAt < Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + 15 * 60_000 });
  else f.count++;
}

export function clearFailures(key: string): void {
  failures.delete(key);
}
