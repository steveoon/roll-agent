import assert from "node:assert/strict";
import { join } from "node:path";
import { runRuntimeShutdownProbe } from "./lib/runtime-shutdown-probe.mjs";

const [node, appRoot, root] = process.argv.slice(2);
assert.ok(
  node && appRoot && root,
  "Pass exact private Node, bundled app root and nonexistent owned root",
);
await runRuntimeShutdownProbe({
  node,
  entry: join(appRoot, "node_modules/@roll-agent/core/dist/cli/index.js"),
  clientEntry: join(appRoot, "node_modules/@roll-agent/client-node/dist/index.js"),
  root,
  modes:
    process.platform === "win32"
      ? ["eof", "cancel-eof"]
      : ["eof", "cancel-eof", "sigint", "sigterm"],
});
