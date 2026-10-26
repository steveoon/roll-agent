import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { preflightToolCall } from "./preflight.ts";
import { readExecutionTimeoutMs, ROLL_EXECUTION_TIMEOUT_META_KEY } from "./execution-timeout.ts";
import { extractTextContent, isToolErrorResult } from "./results.ts";

for (const entry of ["skills", "tool-contracts", "host-contracts"]) {
  test(`${entry} loads without Core, Engine, Session or SQLite initialization`, () => {
    const loader = `export async function resolve(specifier, context, nextResolve) {
      const result = await nextResolve(specifier, context);
      if (/\\/packages\\/core\\/|\\/(?:conversation-engine|agent-session|thread-store)\\.(?:ts|js)$/.test(result.url) || result.url === "node:sqlite") {
        throw new Error("Leaf entry loaded execution implementation: " + result.url);
      }
      return result;
    }`;
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--experimental-loader",
        `data:text/javascript,${encodeURIComponent(loader)}`,
        "--input-type=module",
        "--eval",
        `await import("@roll-agent/runtime/${entry}");`,
      ],
      { cwd: new URL("../..", import.meta.url), stdio: "pipe" },
    );
  });
}

test("shared preflight preserves explicit input, nested types and runtime admission issues", () => {
  const tool = {
    inputSchema: {
      type: "object" as const,
      properties: {
        metadata: { type: "object" },
        rows: { type: "array", minItems: 1, items: { type: "integer" } },
        mode: { type: "string", enum: ["read", "write"] },
      },
      required: ["metadata", "rows"],
      additionalProperties: false,
    },
  };
  const missing = preflightToolCall(tool, {});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(
      missing.issues.map(({ path, code }) => ({ path, code })),
      [
        { path: "metadata", code: "requires_explicit_input" },
        { path: "rows", code: "missing_required" },
      ],
    );
  }
  const invalid = preflightToolCall(tool, {
    metadata: {},
    rows: ["text"],
    mode: "other",
    extra: true,
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.deepEqual(
      invalid.issues.map(({ code }) => code),
      ["invalid_type", "invalid_enum", "unexpected_property"],
    );
  }
  assert.deepEqual(
    preflightToolCall(tool, { metadata: { custom: true }, rows: [1], mode: "read" }),
    { ok: true },
  );
  const runtimeIssues = [
    {
      category: "env" as const,
      code: "missing_required_env" as const,
      name: "TOKEN",
      message: "missing",
    },
  ];
  const blocked = preflightToolCall(tool, { metadata: {}, rows: [1] }, { runtimeIssues });
  assert.deepEqual(blocked, { ok: false, issues: [], runtimeIssues });
});

test("execution deadlines remain safe integers within the advertised bounds", () => {
  for (const value of [1000, 1_800_000]) {
    assert.equal(readExecutionTimeoutMs({ [ROLL_EXECUTION_TIMEOUT_META_KEY]: value }), value);
  }
  for (const value of [999, 1_800_001, 1000.5, Infinity, NaN, "1000", null]) {
    assert.equal(readExecutionTimeoutMs({ [ROLL_EXECUTION_TIMEOUT_META_KEY]: value }), undefined);
  }
  assert.equal(readExecutionTimeoutMs([]), undefined);
});

test("completed App output preserves execution success only for declared consumers", () => {
  const result = {
    isError: true,
    _meta: { "roll/executionStatus": "completed", "roll/appOutputStatus": "invalid" },
  };
  const contract = {
    schemaId: "fixture",
    schemaVersion: 1,
    remoteReadable: false,
    outputSchema: { type: "object" },
  };
  assert.equal(isToolErrorResult(result), true);
  assert.equal(isToolErrorResult(result, contract), false);
  assert.deepEqual(
    extractTextContent([
      { type: "text", text: "first" },
      null,
      { type: "image", data: "second" },
      { type: "text", text: "last" },
    ]),
    ["first", "last"],
  );
});
