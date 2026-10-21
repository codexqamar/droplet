/**
 * Account security state machine: tamper detection → lockout → email → recovery → clean reinstall.
 *
 * Pure and side-effect free: `transition()` returns the next state plus a list of effects.
 * The executor (tripwire.ts / recovery.ts) persists the state change and runs the effects
 * inside one DB transaction, with outbound email sent after commit via the outbox.
 *
 *   ACTIVE ──TAMPER_CONFIRMED──▶ LOCKED_TAMPER ──RECOVERY_EMAIL_SENT──▶ RECOVERY_PENDING
 *                                    ▲   ▲                                   │   │
 *                                    │   └──────RECOVERY_TOKEN_EXPIRED───────┘   │
 *                                    │                                RECOVERY_REDEEMED (token + MFA)
 *                         TAMPER_CONFIRMED                                       ▼
 *                         (from any state)                              RECOVERY_VERIFIED
 *                                    │                                           │ CLEAN_BUILD_ISSUED
 *   ACTIVE ◀──CLEAN_ATTESTATION_PASSED── AWAITING_CLEAN_INSTALL ◀───────────────┘
 */

export type SecurityState =
  | "ACTIVE"
  | "LOCKED_TAMPER"
  | "RECOVERY_PENDING"
  | "RECOVERY_VERIFIED"
  | "AWAITING_CLEAN_INSTALL";

export type SecurityEvent =
  | { type: "TAMPER_CONFIRMED"; deviceId: string; attestationId: string }
  | { type: "RECOVERY_EMAIL_SENT"; incidentId: string }
  | { type: "RECOVERY_TOKEN_EXPIRED"; incidentId: string }
  | { type: "RECOVERY_REDEEMED"; incidentId: string; userId: string; mfaVerified: boolean }
  | { type: "CLEAN_BUILD_ISSUED"; incidentId: string; releaseId: string }
  | { type: "CLEAN_ATTESTATION_PASSED"; incidentId: string; deviceId: string; quarantinedDeviceIds: string[] }
  | { type: "ADMIN_OVERRIDE_UNLOCK"; adminId: string; reason: string };

export type SecurityEffect =
  | { kind: "REVOKE_WEB_SESSIONS" }
  | { kind: "REVOKE_SYNC_TOKENS" }
  | { kind: "QUARANTINE_DEVICE"; deviceId: string }
  | { kind: "OPEN_INCIDENT"; deviceId: string; attestationId: string }
  | { kind: "SEND_TAMPER_ALERT_WITH_RECOVERY_TOKEN" }
  | { kind: "REVOKE_DEVICE_CERTIFICATES"; scope: "QUARANTINED" }
  | { kind: "ISSUE_RECOVERY_DOWNLOAD_GRANT" }
  | { kind: "RESOLVE_INCIDENT"; incidentId: string }
  | { kind: "AUDIT"; action: string; meta?: Record<string, unknown> };

export class IllegalTransition extends Error {
  constructor(public readonly from: SecurityState, public readonly event: SecurityEvent["type"], why = "") {
    super(`Illegal security transition ${from} --${event}--> ${why}`.trim());
  }
}

export interface TransitionResult {
  next: SecurityState;
  effects: SecurityEffect[];
}

export function transition(from: SecurityState, event: SecurityEvent): TransitionResult {
  switch (event.type) {
    // A confirmed tamper report wins from every state, including mid-recovery: a second
    // compromised machine must not ride on an in-flight recovery.
    case "TAMPER_CONFIRMED":
      return {
        next: "LOCKED_TAMPER",
        effects: [
          { kind: "REVOKE_WEB_SESSIONS" },
          { kind: "REVOKE_SYNC_TOKENS" },
          { kind: "QUARANTINE_DEVICE", deviceId: event.deviceId },
          { kind: "OPEN_INCIDENT", deviceId: event.deviceId, attestationId: event.attestationId },
          { kind: "SEND_TAMPER_ALERT_WITH_RECOVERY_TOKEN" },
          { kind: "AUDIT", action: "security.lock", meta: { deviceId: event.deviceId, from } },
        ],
      };

    case "RECOVERY_EMAIL_SENT":
      if (from !== "LOCKED_TAMPER") throw new IllegalTransition(from, event.type);
      return { next: "RECOVERY_PENDING", effects: [{ kind: "AUDIT", action: "security.recovery_email_sent" }] };

    case "RECOVERY_TOKEN_EXPIRED":
      if (from !== "RECOVERY_PENDING") throw new IllegalTransition(from, event.type);
      return { next: "LOCKED_TAMPER", effects: [{ kind: "AUDIT", action: "security.recovery_token_expired" }] };

    case "RECOVERY_REDEEMED":
      if (from !== "RECOVERY_PENDING") throw new IllegalTransition(from, event.type);
      if (!event.mfaVerified) throw new IllegalTransition(from, event.type, "(MFA not verified)");
      return {
        next: "RECOVERY_VERIFIED",
        effects: [
          { kind: "REVOKE_DEVICE_CERTIFICATES", scope: "QUARANTINED" },
          { kind: "AUDIT", action: "security.recovery_verified", meta: { userId: event.userId } },
        ],
      };

    case "CLEAN_BUILD_ISSUED":
      if (from !== "RECOVERY_VERIFIED") throw new IllegalTransition(from, event.type);
      return {
        next: "AWAITING_CLEAN_INSTALL",
        effects: [
          { kind: "ISSUE_RECOVERY_DOWNLOAD_GRANT" },
          { kind: "AUDIT", action: "security.clean_build_issued", meta: { releaseId: event.releaseId } },
        ],
      };

    case "CLEAN_ATTESTATION_PASSED":
      if (from !== "AWAITING_CLEAN_INSTALL") throw new IllegalTransition(from, event.type);
      // The passing device must be a fresh enrollment, never a quarantined one re-attesting.
      if (event.quarantinedDeviceIds.includes(event.deviceId)) {
        throw new IllegalTransition(from, event.type, "(attesting device is quarantined)");
      }
      return {
        next: "ACTIVE",
        effects: [
          { kind: "RESOLVE_INCIDENT", incidentId: event.incidentId },
          { kind: "AUDIT", action: "security.unlocked", meta: { deviceId: event.deviceId } },
        ],
      };

    case "ADMIN_OVERRIDE_UNLOCK":
      if (from === "ACTIVE") throw new IllegalTransition(from, event.type, "(already active)");
      return {
        next: "ACTIVE",
        effects: [{ kind: "AUDIT", action: "security.admin_override", meta: { adminId: event.adminId, reason: event.reason } }],
      };
  }
}

/** Anything other than ACTIVE blocks portal access, ordering and desktop sync. */
export const isLocked = (s: SecurityState): boolean => s !== "ACTIVE";
