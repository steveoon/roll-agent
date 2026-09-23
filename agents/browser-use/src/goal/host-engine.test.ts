import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOperateEngine } from "./host.ts";

test("standard mode is the default even when a TypeSafe key exists", () => {
  assert.equal(resolveOperateEngine(undefined, { TYPESAFE_API_KEY: "key" }), "sampling");
  assert.equal(resolveOperateEngine(undefined, { BROWSER_OPERATE_ENGINE: "sampling" }), "sampling");
});

test("fast mode requires an explicit Roll engine setting", () => {
  assert.equal(
    resolveOperateEngine(undefined, { BROWSER_OPERATE_ENGINE: "jev", TYPESAFE_API_KEY: "key" }),
    "jev",
  );
  assert.throws(
    () => resolveOperateEngine("jev", { TYPESAFE_API_KEY: "key" }),
    /cannot override browser\.operate\.engine/u,
  );
  assert.throws(
    () =>
      resolveOperateEngine("sampling", {
        BROWSER_OPERATE_ENGINE: "jev",
        TYPESAFE_API_KEY: "key",
      }),
    /cannot override browser\.operate\.engine/u,
  );
});

test("fast mode without a key fails before browser access", () => {
  assert.throws(
    () => resolveOperateEngine(undefined, { BROWSER_OPERATE_ENGINE: "jev" }),
    /TYPESAFE_API_KEY is missing/u,
  );
  assert.throws(
    () => resolveOperateEngine(undefined, { BROWSER_OPERATE_ENGINE: "jev", TYPESAFE_API_KEY: " " }),
    /TYPESAFE_API_KEY is missing/u,
  );
});

test("invalid injected engine fails before browser access", () => {
  assert.throws(
    () => resolveOperateEngine(undefined, { BROWSER_OPERATE_ENGINE: "openrouter" }),
    /Invalid BROWSER_OPERATE_ENGINE/u,
  );
});
