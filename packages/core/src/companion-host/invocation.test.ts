import assert from "node:assert/strict";
import test from "node:test";
import { createBundledRollInvocation } from "./invocation.ts";

test("bundled invocation is absolute, PATH-independent and strips inspector flags", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--experimental-sqlite", "--inspect=127.0.0.1:9229"],
  });
  assert.equal(invocation.command, "/bundle/node");
  assert.deepEqual(invocation.runtimeArgs, [
    "--experimental-strip-types",
    "--experimental-sqlite",
    "/bundle/roll.js",
    "runtime",
    "serve",
    "--stdio",
  ]);
  assert.equal(
    invocation.runtimeArgs.some((value) => value.startsWith("--inspect")),
    false,
  );
  assert.deepEqual(invocation.companionArgs.slice(-3), ["companion", "run", "--foreground"]);
});

test("bundled invocation exposes the filtered execArgv for other daemons", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--inspect"],
  });
  assert.deepEqual(invocation.execArgv, ["--experimental-strip-types"]);
});
