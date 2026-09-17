import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile } from "node:fs/promises";
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
await mkdir(path("./dist"), { recursive: true });
await build({
  entryPoints: [path("./agent.ts")],
  outfile: path("./dist/agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  alias: {
    "@roll-agent/sdk": path("../../packages/sdk/src/index.ts"),
    zod: path("../../packages/sdk/node_modules/zod"),
  },
});
await build({
  entryPoints: [path("./web.ts")],
  outfile: path("./dist/web.js"),
  bundle: true,
  platform: "browser",
  define: { __ROLL_LOOPBACK_QA__: String(process.argv.includes("--loopback-qa")) },
  format: "esm",
  alias: {
    "@roll-agent/relay-client/testing": path("../../packages/relay-client/src/testing.ts"),
    "@roll-agent/relay-client": path("../../packages/relay-client/src/index.ts"),
  },
});
await copyFile(path("./index.html"), path("./dist/index.html"));
