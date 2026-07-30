import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAY_FRAME_CONFORMANCE_CASES,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
  RELAY_NEGOTIATION_CONFORMANCE_CASES,
  runRelayProtocolConformance,
  runtimeRelayProtocolConformanceAdapter,
} from "./conformance.ts";
import {
  RELAY_ERROR_CODES,
  RELAY_REQUEST_METHODS,
  RELAY_REQUEST_METHOD_VALUES,
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
