import { test } from "node:test";
import assert from "node:assert/strict";
import { IllegalTransition, transition, type SecurityState } from "../src/security/stateMachine.js";

const tamper = { type: "TAMPER_CONFIRMED", deviceId: "dev-1", attestationId: "att-1" } as const;

test("happy path: tamper → lock → email → MFA recovery → clean build → clean attestation", () => {
  let s: SecurityState = "ACTIVE";
  const r1 = transition(s, tamper);
  assert.equal(r1.next, "LOCKED_TAMPER");
  assert.ok(r1.effects.some((e) => e.kind === "REVOKE_WEB_SESSIONS"));
  assert.ok(r1.effects.some((e) => e.kind === "SEND_TAMPER_ALERT_WITH_RECOVERY_TOKEN"));
  s = r1.next;

  s = transition(s, { type: "RECOVERY_EMAIL_SENT", incidentId: "inc" }).next;
  assert.equal(s, "RECOVERY_PENDING");

  const r3 = transition(s, { type: "RECOVERY_REDEEMED", incidentId: "inc", userId: "u", mfaVerified: true });
  assert.equal(r3.next, "RECOVERY_VERIFIED");
  assert.ok(r3.effects.some((e) => e.kind === "REVOKE_DEVICE_CERTIFICATES"));
  s = r3.next;

  s = transition(s, { type: "CLEAN_BUILD_ISSUED", incidentId: "inc", releaseId: "rel" }).next;
  assert.equal(s, "AWAITING_CLEAN_INSTALL");

  s = transition(s, {
    type: "CLEAN_ATTESTATION_PASSED",
    incidentId: "inc",
    deviceId: "dev-2",
    quarantinedDeviceIds: ["dev-1"],
  }).next;
  assert.equal(s, "ACTIVE");
});

test("recovery without MFA is rejected", () => {
  assert.throws(
    () => transition("RECOVERY_PENDING", { type: "RECOVERY_REDEEMED", incidentId: "i", userId: "u", mfaVerified: false }),
    IllegalTransition,
  );
});

test("quarantined device cannot clear quarantine by re-attesting", () => {
  assert.throws(
    () =>
      transition("AWAITING_CLEAN_INSTALL", {
        type: "CLEAN_ATTESTATION_PASSED",
        incidentId: "i",
        deviceId: "dev-1",
        quarantinedDeviceIds: ["dev-1"],
      }),
    IllegalTransition,
  );
});

test("tamper during recovery re-locks", () => {
  for (const s of ["RECOVERY_PENDING", "RECOVERY_VERIFIED", "AWAITING_CLEAN_INSTALL"] as const) {
    assert.equal(transition(s, tamper).next, "LOCKED_TAMPER");
  }
});

test("expired token returns to locked; cannot skip steps", () => {
  assert.equal(transition("RECOVERY_PENDING", { type: "RECOVERY_TOKEN_EXPIRED", incidentId: "i" }).next, "LOCKED_TAMPER");
  assert.throws(() => transition("LOCKED_TAMPER", { type: "CLEAN_BUILD_ISSUED", incidentId: "i", releaseId: "r" }), IllegalTransition);
  assert.throws(() => transition("ACTIVE", { type: "RECOVERY_EMAIL_SENT", incidentId: "i" }), IllegalTransition);
});
