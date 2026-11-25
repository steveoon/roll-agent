import assert from "node:assert/strict";
import { test } from "node:test";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { z } from "zod/v4";
import {
  RELAY_ERROR_CODES_V14,
  RELAY_ERROR_RETRYABILITY_V14,
  RELAY_MUTATION_REQUEST_METHODS_V14,
  RELAY_REQUEST_METHODS_V14,
  getRelayErrorRetryabilityV14,
  getRelayProtocolRegistry,
  getRelayRequestMethodDispositionForVersion,
  isThreadEffortToggleEnabled,
  negotiateRelayProtocolVersion,
  parseRelayMessageForVersion,
  parseRelayRequestParamsForVersion,
  parseRelayRequestResultForVersion,
  projectRelayMessageV14ToV13,
  projectRelayThreadEffortStatusV14,
} from "./index.ts";
import { parseRelayBrowserFirstControlFrameAny } from "./control.ts";

const Ajv2020 = typeof Ajv2020Module === "function" ? Ajv2020Module : Ajv2020Module.default;
const addFormats =
  typeof addFormatsModule === "function" ? addFormatsModule : addFormatsModule.default;

const IDS = {
  device: "00000000-0000-4000-8000-000000000701",
  workspace: "00000000-0000-4000-8000-000000000702",
  thread: "00000000-0000-4000-8000-000000000703",
  request: "00000000-0000-4000-8000-000000000704",
  innerRequest: "00000000-0000-4000-8000-000000000705",
  revision: "00000000-0000-4000-8000-000000000706",
} as const;

function validPendingStatus() {
  return {
    threadId: IDS.thread,
    revision: IDS.revision,
    configRevision: "cfg-rev-v14",
    effort: { mode: "explicit", level: "high" },
    status: "pending",
    active: {
      provider: "google",
      model: "gemini-4-neon",
      reasoning: "summary",
      effort: "medium",
      effortCapability: {
        kind: "levels",
        levels: ["low", "medium", "high", "xhigh"],
      },
    },
    target: {
      provider: "google",
      model: "gemini-4-neon",
      effectiveEffort: "high",
      effortCapability: {
        kind: "levels",
        levels: ["low", "medium", "high", "xhigh"],
      },
    },
  } as const;
}

test("Relay Wire 1.4 registers per-thread effort query/mutation without exposing model catalog or config APIs", () => {
  assert.equal(
    getRelayRequestMethodDispositionForVersion("1.4", RELAY_REQUEST_METHODS_V14.threadEffortGet),
    "query",
  );
  assert.equal(
    getRelayRequestMethodDispositionForVersion("1.4", RELAY_REQUEST_METHODS_V14.threadEffortSet),
    "mutation",
  );
  assert.ok(RELAY_MUTATION_REQUEST_METHODS_V14.includes(RELAY_REQUEST_METHODS_V14.threadEffortSet));
  assert.equal(getRelayRequestMethodDispositionForVersion("1.3", "thread.effort.get"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.3", "thread.effort.set"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.4", "runtime.models.list"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.4", "thread.model.get"), undefined);
  assert.equal(getRelayRequestMethodDispositionForVersion("1.4", "thread.model.set"), undefined);
  assert.equal(
    getRelayRequestMethodDispositionForVersion("1.4", "runtime.modelConfig.get"),
    undefined,
  );
  assert.equal(
    getRelayRequestMethodDispositionForVersion("1.4", "runtime.modelConfig.reload"),
    undefined,
  );

  assert.equal(negotiateRelayProtocolVersion(["1.2", "1.3", "1.4"]), "1.4");
  assert.equal(negotiateRelayProtocolVersion(["1.2", "1.3"]), "1.3");
  assert.equal(negotiateRelayProtocolVersion(["1.2"]), "1.2");

  assert.equal(getRelayErrorRetryabilityV14(RELAY_ERROR_CODES_V14.threadEffortStateStale), true);
  assert.equal(getRelayErrorRetryabilityV14(RELAY_ERROR_CODES_V14.threadEffortUnsupported), false);
  assert.equal(RELAY_ERROR_RETRYABILITY_V14.THREAD_EFFORT_STATE_STALE, true);
  assert.equal(RELAY_ERROR_RETRYABILITY_V14.THREAD_EFFORT_UNSUPPORTED, false);

  assert.equal(
    isThreadEffortToggleEnabled({ kind: "toggle", offLevel: "off", onLevel: "medium" }, "high"),
    true,
  );
  assert.equal(
    isThreadEffortToggleEnabled({ kind: "toggle", offLevel: "off", onLevel: "medium" }, "off"),
    false,
  );
});

test("Control 1.0 session.ready accepts Relay Wire 1.4 and downgrades device.connect cleanly", () => {
  const ready = parseRelayBrowserFirstControlFrameAny({
    type: "session.ready",
    controlVersion: "1.0",
    relayProtocolVersion: "1.4",
    sessionId: "session-v14",
    workspaceId: IDS.workspace,
    workspaceStatus: "online",
  });
  assert.equal(ready.relayProtocolVersion, "1.4");

  const connect14 = parseRelayMessageForVersion("1.4", {
    type: "device.connect",
    protocolVersion: "1.4",
    deviceId: IDS.device,
    pairingToken: "pairing-token-at-least-sixteen",
  });
  assert.equal(projectRelayMessageV14ToV13(connect14).type, "device.connect");
});

test("projectRelayThreadEffortStatusV14 strips model selection and contextWindow while preserving status invariants", () => {
  const runtimeStatus = {
    ...validPendingStatus(),
    selection: { mode: "explicit", provider: "google", model: "gemini-4-neon" },
    active: {
      ...validPendingStatus().active,
      contextWindow: 200_000,
    },
  };
  const projected = projectRelayThreadEffortStatusV14(runtimeStatus);
  assert.equal("selection" in projected, false);
  assert.equal(projected.active !== null && "contextWindow" in projected.active, false);
  assert.equal(projected.target.effectiveEffort, "high");
  assert.equal(projected.active?.effort, "medium");
});

test("Relay 1.4 JSON Schemas match runtime effort status and mutation validation", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const methods = getRelayProtocolRegistry("1.4").requestMethodSchemas;
  const validateGetResult = ajv.compile(z.toJSONSchema(methods["thread.effort.get"].result));
  const validateSetParams = ajv.compile(z.toJSONSchema(methods["thread.effort.set"].params));

  const baseStatus = validPendingStatus();
  const atLimit = {
    ...baseStatus,
    active: { ...baseStatus.active, provider: "p".repeat(128), model: "m".repeat(512) },
  };
  for (const valid of [baseStatus, atLimit]) {
    assert.ok(validateGetResult(valid), "JSON Schema accepts valid statuses");
    assert.deepEqual(parseRelayRequestResultForVersion("1.4", "thread.effort.get", valid), valid);
  }
  for (const [label, overrides] of [
    [
      "duplicate levels",
      {
        target: {
          ...baseStatus.target,
          effortCapability: { kind: "levels", levels: ["low", "low"] },
        },
      },
    ],
    [
      "identical toggle levels",
      {
        target: {
          ...baseStatus.target,
          effortCapability: { kind: "toggle", offLevel: "medium", onLevel: "medium" },
        },
      },
    ],
    ["applied without active", { status: "applied", active: null }],
    ["failed without reason", { status: "failed" }],
    [
      "provider over 128 characters",
      { active: { ...baseStatus.active, provider: "p".repeat(129) } },
    ],
    ["model over 512 characters", { active: { ...baseStatus.active, model: "m".repeat(513) } }],
  ] as const) {
    const invalid = { ...baseStatus, ...overrides };
    assert.equal(validateGetResult(invalid), false, label);
    assert.throws(
      () => parseRelayRequestResultForVersion("1.4", "thread.effort.get", invalid),
      label,
    );
  }

  const validSet = {
    requestId: IDS.innerRequest,
    threadId: IDS.thread,
    expectedRevision: IDS.revision,
    configRevision: "cfg-rev-v14",
    effort: { mode: "default" },
  };
  assert.equal(validateSetParams(validSet), true);
  assert.deepEqual(
    parseRelayRequestParamsForVersion("1.4", "thread.effort.set", validSet),
    validSet,
  );

  const setWithSelection = {
    ...validSet,
    selection: { mode: "default" },
  };
  assert.equal(
    validateSetParams(setWithSelection),
    false,
    "Ajv must reject selection in effort.set",
  );
  assert.throws(() =>
    parseRelayRequestParamsForVersion("1.4", "thread.effort.set", setWithSelection),
  );
});
