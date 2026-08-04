import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAY_FRAME_CONFORMANCE_CASES,
  RELAY_FRAME_CONFORMANCE_CASES_V11,
  RELAY_METHOD_CONFORMANCE_CASES,
  RELAY_METHOD_CONFORMANCE_CASES_V11,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11,
  RELAY_NEGOTIATION_CONFORMANCE_CASES,
  RELAY_NEGOTIATION_CONFORMANCE_CASES_V11,
  RELAY_REPLAY_CONFORMANCE_CASES_V11,
  runRelayProtocolConformance,
  runRelayProtocolConformanceForVersion,
  runtimeRelayProtocolConformanceAdapter,
  runtimeRelayProtocolConformanceAdapterV10,
  runtimeRelayProtocolConformanceAdapterV11,
} from "./conformance.ts";
import {
  RELAY_ERROR_CODES,
  RELAY_REQUEST_METHODS,
  RELAY_REQUEST_METHODS_V11,
  RELAY_REQUEST_METHOD_VALUES,
  RELAY_REQUEST_METHOD_VALUES_V11,
  RELAY_REQUEST_REPLAY_DISPOSITIONS,
} from "./index.ts";

test("default Relay Protocol implementation passes the reusable conformance suite", () => {
  assert.equal(RELAY_FRAME_CONFORMANCE_CASES.length, 14);
  assert.deepEqual(
    RELAY_NEGOTIATION_CONFORMANCE_CASES.map((entry) => entry.expected),
    ["1.0", "1.0", undefined],
  );
  assert.equal(
    RELAY_METHOD_REGISTRY_CONFORMANCE_CASES.filter((entry) => entry.expected !== undefined).length,
    RELAY_REQUEST_METHOD_VALUES.length,
  );
  assert.deepEqual(runRelayProtocolConformance(runtimeRelayProtocolConformanceAdapter), {
    protocolVersion: "1.0",
    passed: true,
    failures: [],
  });
});

test("legacy conformance exports and the one-argument runner remain pinned to Wire 1.0", () => {
  assert.equal(runtimeRelayProtocolConformanceAdapterV10, runtimeRelayProtocolConformanceAdapter);
  assert.equal(runtimeRelayProtocolConformanceAdapterV10.negotiate(["1.1"]), undefined);
  assert.equal(runtimeRelayProtocolConformanceAdapterV10.negotiate(["1.1", "1.0"]), "1.0");
  assert.deepEqual(
    RELAY_FRAME_CONFORMANCE_CASES.map((entry) => entry.id),
    [
      "device-connect",
      "runtime-request",
      "runtime-response",
      "runtime-event",
      "runtime-ack",
      "runtime-gap",
      "runtime-encrypted",
      "unknown-version",
      "unknown-message",
      "unknown-method",
      "invalid-id",
      "extra-field",
      "invalid-gap-recovery",
      "encrypted-metadata-leak",
    ],
  );
  assert.deepEqual(
    RELAY_NEGOTIATION_CONFORMANCE_CASES.map((entry) => entry.id),
    ["same-version", "unknown-before-supported", "unknown-only"],
  );
  assert.deepEqual(
    RELAY_METHOD_CONFORMANCE_CASES.map((entry) => entry.id),
    ["approval-candidate-params", "approval-candidate-empty-reason", "approval-candidate-result"],
  );
  assert.deepEqual(
    runRelayProtocolConformanceForVersion("1.0", runtimeRelayProtocolConformanceAdapterV10),
    runRelayProtocolConformance(runtimeRelayProtocolConformanceAdapter),
  );
});

test("Relay Wire 1.1 conformance covers Interaction, security and N/N-1 behavior", () => {
  assert.deepEqual(
    runRelayProtocolConformanceForVersion("1.1", runtimeRelayProtocolConformanceAdapterV11),
    {
      protocolVersion: "1.1",
      passed: true,
      failures: [],
    },
  );
  assert.deepEqual(
    RELAY_NEGOTIATION_CONFORMANCE_CASES_V11.map((entry) => entry.expected),
    ["1.1", "1.1", "1.0", "1.1", undefined],
  );
  assert.equal(
    RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11.filter((entry) => entry.expected !== undefined)
      .length,
    RELAY_REQUEST_METHOD_VALUES_V11.length,
  );
  assert.deepEqual(
    RELAY_METHOD_CONFORMANCE_CASES_V11.map((entry) => entry.method),
    Array.from(
      { length: RELAY_METHOD_CONFORMANCE_CASES_V11.length },
      () => RELAY_REQUEST_METHODS_V11.interactionCandidate,
    ),
  );
  assert.deepEqual(
    RELAY_REPLAY_CONFORMANCE_CASES_V11.map((entry) => [entry.id, entry.expected.disposition]),
    [
      ["interaction-candidate-duplicate", "replay"],
      ["interaction-candidate-conflict", "conflict"],
      ["interaction-candidate-different-request-id", "new"],
      ["interaction-candidate-different-workspace", "new"],
    ],
  );

  const validInteraction = RELAY_FRAME_CONFORMANCE_CASES_V11.find(
    (entry) => entry.id === "interaction-request-user-input",
  );
  assert.ok(validInteraction?.valid);
  assert.equal(
    runtimeRelayProtocolConformanceAdapterV10.validateFrame(validInteraction.frame),
    false,
  );
  assert.equal(
    runtimeRelayProtocolConformanceAdapterV11.negotiate(["1.0"]),
    "1.0",
    "a Wire 1.1 peer must explicitly fall back to N-1",
  );

  const securityCaseIds = [
    "approval-projection-raw-input-leak",
    "user-input-projection-secret-leak",
    "non-normal-sensitivity-rejected",
    "authentication-local-only",
    "file-picker-local-only",
    "interaction-resolved-result-leak",
    "interaction-cancelled-reason-leak",
    "runtime-event-tool-input-leak",
    "runtime-event-tool-output-leak",
  ] as const;
  for (const caseId of securityCaseIds) {
    const entry = RELAY_FRAME_CONFORMANCE_CASES_V11.find((candidate) => candidate.id === caseId);
    assert.ok(entry, `missing Relay Wire 1.1 security case: ${caseId}`);
    assert.equal(entry.valid, false);
    assert.equal(runtimeRelayProtocolConformanceAdapterV11.validateFrame(entry.frame), false);
  }
  assert.equal(
    RELAY_FRAME_CONFORMANCE_CASES_V11.filter((entry) => entry.valid)
      .map((entry) => JSON.stringify(entry.frame))
      .some((frame) => frame.includes("relay-security-sentinel")),
    false,
  );
});

test("Relay Wire 1.1 conformance reports stable version-specific case IDs", () => {
  const result = runRelayProtocolConformanceForVersion("1.1", {
    ...runtimeRelayProtocolConformanceAdapterV11,
    validateFrame: () => true,
    getRequestMethodDisposition(value) {
      if (value === RELAY_REQUEST_METHODS_V11.interactionCandidate) {
        return undefined;
      }
      return runtimeRelayProtocolConformanceAdapterV11.getRequestMethodDisposition(value);
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.protocolVersion, "1.1");
  assert.equal(
    result.failures.some((failure) => failure.caseId === "approval-projection-raw-input-leak"),
    true,
  );
  assert.equal(
    result.failures.some(
      (failure) =>
        failure.caseId ===
        `method-disposition-v11-${RELAY_REQUEST_METHODS_V11.interactionCandidate}`,
    ),
    true,
  );
});

test("conformance validates exact method dispositions and replay error-code shape", () => {
  const result = runRelayProtocolConformance({
    ...runtimeRelayProtocolConformanceAdapter,
    getRequestMethodDisposition(value) {
      if (value === RELAY_REQUEST_METHODS.initialize) {
        return "query";
      }
      if (value === RELAY_REQUEST_METHODS.threadSnapshot) {
        return undefined;
      }
      if (value === "runtime.futureMethod") {
        return "mutation";
      }
      return runtimeRelayProtocolConformanceAdapter.getRequestMethodDisposition(value);
    },
    classifyReplay(existing, candidate) {
      const classification = runtimeRelayProtocolConformanceAdapter.classifyReplay(
        existing,
        candidate,
      );
      if (classification.disposition === RELAY_REQUEST_REPLAY_DISPOSITIONS.conflict) {
        return {
          ...classification,
          errorCode: RELAY_ERROR_CODES.companionError,
        };
      }
      return classification.disposition === RELAY_REQUEST_REPLAY_DISPOSITIONS.new
        ? { ...classification, errorCode: RELAY_ERROR_CODES.requestIdConflict }
        : classification;
    },
    classifyAck: () => "advance",
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(
      (failure) => failure.caseId === `method-disposition-${RELAY_REQUEST_METHODS.initialize}`,
    ),
    true,
  );
  assert.equal(
    result.failures.some(
      (failure) => failure.caseId === `method-disposition-${RELAY_REQUEST_METHODS.threadSnapshot}`,
    ),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "unknown-method-not-recognized"),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "same-id-different-payload-error-code"),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "different-request-id-error-code"),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "equal-duplicate-ack"),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "ack-beyond-advertised"),
    true,
  );
});

test("conformance reports stable case IDs for external implementations", () => {
  const result = runRelayProtocolConformance({
    ...runtimeRelayProtocolConformanceAdapter,
    validateFrame: () => false,
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some((failure) => failure.caseId === "device-connect"),
    true,
  );
  assert.equal(
    result.failures.some((failure) => failure.caseId === "unknown-message"),
    false,
  );
});
