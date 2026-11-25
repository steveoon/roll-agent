import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { z } from "zod/v4";
import {
  isRuntimeMethodAvailable,
  isThreadEffortToggleEnabled,
  parseRuntimeMethodParamsForVersion,
  parseRuntimeMethodResultForVersion,
  projectRuntimeModelCatalogForVersion,
  projectThreadModelStatusForVersion,
  runtimeMethodSchemas,
  threadEffortCapabilitySchema,
  threadEffortSelectionSchema,
  threadModelSelectionSchema,
  threadModelSetParamsV16Schema,
  threadModelSetParamsV17Schema,
  threadModelStatusSchema,
  threadModelStatusV16Schema,
} from "./index.ts";

const Ajv2020 = typeof Ajv2020Module === "function" ? Ajv2020Module : Ajv2020Module.default;
const addFormats =
  typeof addFormatsModule === "function" ? addFormatsModule : addFormatsModule.default;

test("thread model methods are optional 1.6+ extensions", () => {
  for (const method of ["runtime.models.list", "thread.model.get", "thread.model.set"] as const) {
    assert.equal(isRuntimeMethodAvailable("1.7", method), true);
    assert.equal(isRuntimeMethodAvailable("1.6", method), true);
    for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"] as const) {
      assert.equal(isRuntimeMethodAvailable(version, method), false);
    }
  }
});

test("model selection rejects incomplete, unbounded and credential-bearing values", () => {
  assert.deepEqual(threadModelSelectionSchema.parse({ mode: "default" }), { mode: "default" });
  assert.deepEqual(
    threadModelSelectionSchema.parse({ mode: "explicit", provider: "p", model: "m" }),
    { mode: "explicit", provider: "p", model: "m" },
  );
  for (const value of [
    { mode: "explicit", provider: "p" },
    { mode: "default", model: "m" },
    { mode: "explicit", provider: "p", model: "x".repeat(513) },
    { mode: "explicit", provider: "p", model: "m", apiKey: "secret" },
  ]) {
    assert.equal(threadModelSelectionSchema.safeParse(value).success, false);
  }
  assert.equal(runtimeMethodSchemas["runtime.models.list"].params.safeParse({}).success, true);
  assert.equal(
    threadModelStatusSchema.safeParse({ status: "failed", reason: "private error" }).success,
    false,
  );
  assert.equal(
    threadModelStatusV16Schema.safeParse({
      threadId: randomUUID(),
      revision: randomUUID(),
      configRevision: "config",
      selection: { mode: "default" },
      status: "applied",
      active: null,
    }).success,
    false,
  );
});

test("Protocol 1.7 effort schemas validate capabilities, selections and partial mutations while keeping 1.6 frozen", () => {
  assert.deepEqual(threadEffortSelectionSchema.parse({ mode: "default" }), { mode: "default" });
  assert.deepEqual(threadEffortSelectionSchema.parse({ mode: "explicit", level: "xhigh" }), {
    mode: "explicit",
    level: "xhigh",
  });
  assert.equal(
    threadEffortSelectionSchema.safeParse({ mode: "explicit", level: "turbo" }).success,
    false,
  );
  assert.equal(
    threadEffortSelectionSchema.safeParse({ mode: "default", level: "medium" }).success,
    false,
  );

  assert.equal(
    threadEffortCapabilitySchema.safeParse({
      kind: "levels",
      levels: ["low", "medium", "high", "xhigh"],
    }).success,
    true,
  );
  assert.equal(
    threadEffortCapabilitySchema.safeParse({
      kind: "levels",
      levels: ["high"],
    }).success,
    false,
  );
  assert.equal(
    threadEffortCapabilitySchema.safeParse({
      kind: "levels",
      levels: ["low", "low"],
    }).success,
    false,
  );
  const toggleCap = threadEffortCapabilitySchema.parse({
    kind: "toggle",
    offLevel: "off",
    onLevel: "medium",
  });
  assert.equal(toggleCap.kind, "toggle");
  assert.equal(isThreadEffortToggleEnabled(toggleCap, "off"), false);
  assert.equal(isThreadEffortToggleEnabled(toggleCap, "medium"), true);
  assert.equal(isThreadEffortToggleEnabled(toggleCap, "high"), true);
  assert.equal(
    threadEffortCapabilitySchema.safeParse({
      kind: "toggle",
      offLevel: "off",
      onLevel: "off",
    }).success,
    false,
  );

  const baseSetFields = {
    requestId: randomUUID(),
    threadId: randomUUID(),
    expectedRevision: randomUUID(),
    configRevision: "cfg-1",
  };
  assert.equal(
    threadModelSetParamsV17Schema.safeParse({
      ...baseSetFields,
      effort: { mode: "explicit", level: "high" },
    }).success,
    true,
  );
  assert.equal(
    threadModelSetParamsV17Schema.safeParse({
      ...baseSetFields,
      selection: { mode: "default" },
    }).success,
    true,
  );
  assert.equal(threadModelSetParamsV17Schema.safeParse(baseSetFields).success, false);
  assert.equal(
    threadModelSetParamsV16Schema.safeParse({
      ...baseSetFields,
      selection: { mode: "default" },
      effort: { mode: "explicit", level: "high" },
    }).success,
    false,
  );
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion("1.6", "thread.model.set", {
      ...baseSetFields,
      effort: { mode: "explicit", level: "high" },
    }),
  );
});

test("Protocol 1.7 model catalog and status project strictly down to frozen 1.6 shapes", () => {
  const catalogV17 = {
    configRevision: "cfg-1",
    defaultModel: { provider: "google", model: "gemini-4-neon" },
    defaultEffort: "medium" as const,
    items: [
      {
        provider: "google",
        model: "gemini-4-neon",
        available: true,
        effortCapability: {
          kind: "levels" as const,
          levels: ["low", "medium", "high", "xhigh"] as const,
        },
      },
      {
        provider: "deepseek",
        model: "deepseek-chat",
        available: true,
        effortCapability: {
          kind: "toggle" as const,
          offLevel: "off" as const,
          onLevel: "medium" as const,
        },
      },
    ],
  };
  const projectedCatalogV16 = projectRuntimeModelCatalogForVersion("1.6", catalogV17);
  assert.deepEqual(
    parseRuntimeMethodResultForVersion("1.6", "runtime.models.list", projectedCatalogV16),
    {
      configRevision: "cfg-1",
      defaultModel: { provider: "google", model: "gemini-4-neon" },
      items: [
        { provider: "google", model: "gemini-4-neon", available: true },
        { provider: "deepseek", model: "deepseek-chat", available: true },
      ],
    },
  );
  assert.throws(() => parseRuntimeMethodResultForVersion("1.6", "runtime.models.list", catalogV17));

  const threadId = randomUUID();
  const revision = randomUUID();
  const pendingStatusV17 = {
    threadId,
    revision,
    selection: { mode: "default" as const },
    effort: { mode: "default" as const },
    target: {
      provider: "google",
      model: "gemini-4-neon",
      effectiveEffort: "medium" as const,
      effortCapability: {
        kind: "levels" as const,
        levels: ["low", "medium", "high", "xhigh"] as const,
      },
    },
    configRevision: "cfg-1",
    status: "pending" as const,
    active: {
      provider: "google",
      model: "gemini-4-neon",
      reasoning: "summary" as const,
      contextWindow: 1_048_576,
      effort: "high" as const,
      effortCapability: {
        kind: "levels" as const,
        levels: ["low", "medium", "high", "xhigh"] as const,
      },
    },
  };
  assert.equal(
    parseRuntimeMethodResultForVersion("1.7", "thread.model.get", pendingStatusV17).target
      .effectiveEffort,
    "medium",
  );
  const projectedPendingV16 = projectThreadModelStatusForVersion("1.6", pendingStatusV17);
  assert.deepEqual(
    parseRuntimeMethodResultForVersion("1.6", "thread.model.get", projectedPendingV16),
    {
      threadId,
      revision,
      selection: { mode: "default" },
      configRevision: "cfg-1",
      status: "pending",
      active: {
        provider: "google",
        model: "gemini-4-neon",
        reasoning: "summary",
        contextWindow: 1_048_576,
      },
    },
  );
  assert.throws(() =>
    parseRuntimeMethodResultForVersion("1.6", "thread.model.get", pendingStatusV17),
  );

  const failedEffortV17 = {
    ...pendingStatusV17,
    status: "failed" as const,
    reason: "effort-unsupported" as const,
  };
  const projectedFailedV16 = projectThreadModelStatusForVersion("1.6", failedEffortV17);
  assert.equal(projectedFailedV16.status, "failed");
  assert.equal(projectedFailedV16.reason, "config-changed");
});

test("generated Runtime 1.7 JSON Schema enforces duplicate-level, distinct-toggle and non-empty-mutation invariants", () => {
  const schemaText = readFileSync(
    new URL("../dist/schema/roll-runtime-protocol-v1.7.schema.json", import.meta.url),
    "utf8",
  );
  const rootSchema = z.looseObject({ $id: z.string() }).parse(JSON.parse(schemaText));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const keyword of [
    "x-roll-protocol-version",
    "x-roll-methods",
    "x-roll-server-request-methods",
  ]) {
    ajv.addKeyword({ keyword });
  }
  ajv.addSchema(rootSchema);

  const validateGetResult = ajv.getSchema(`${rootSchema.$id}#/$defs/threadModelGetResult`);
  const validateSetParams = ajv.getSchema(`${rootSchema.$id}#/$defs/threadModelSetParams`);
  assert.ok(validateGetResult);
  assert.ok(validateSetParams);

  const validFixture = z
    .object({ result: threadModelStatusSchema })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("../fixtures/v1.7/valid-thread-model-status-pending.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  assert.equal(validateGetResult(validFixture.result), true);

  for (const invalidCapability of [
    { kind: "levels", levels: ["low", "low"] },
    { kind: "levels", levels: ["high"] },
    { kind: "toggle", offLevel: "medium", onLevel: "medium" },
    { kind: "toggle", offLevel: "off", onLevel: "off" },
  ]) {
    const candidate: Record<string, unknown> = {
      ...validFixture.result,
      target: {
        ...validFixture.result.target,
        effortCapability: invalidCapability,
      },
    };
    assert.equal(
      validateGetResult(candidate),
      false,
      `expected JSON Schema to reject ${JSON.stringify(invalidCapability)}`,
    );
    assert.equal(
      threadModelStatusSchema.safeParse(candidate).success,
      false,
      `expected Zod to reject ${JSON.stringify(invalidCapability)}`,
    );
  }

  const emptyMutation = {
    requestId: randomUUID(),
    threadId: randomUUID(),
    expectedRevision: randomUUID(),
    configRevision: "cfg-1",
  };
  assert.equal(validateSetParams(emptyMutation), false);
  assert.equal(threadModelSetParamsV17Schema.safeParse(emptyMutation).success, false);
});
