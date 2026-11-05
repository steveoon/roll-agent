import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runRuntimeShutdownProbe } from "./lib/runtime-shutdown-probe.mjs";

test(
  "actual Runtime drains HTTP, MCP, claims and signal/EOF shutdown",
  { timeout: 120_000 },
  async () => {
    await runRuntimeShutdownProbe({
      node: process.execPath,
      entry: resolve("packages/core/src/cli/index.ts"),
      clientEntry: resolve("packages/client-node/src/index.ts"),
      root: resolve(tmpdir(), `roll-shutdown-${randomUUID()}`),
      modes:
        process.platform === "win32"
          ? ["eof", "cancel-eof"]
          : ["eof", "cancel-eof", "sigint", "sigterm"],
    });
  },
);
