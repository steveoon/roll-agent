import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const outputDirectory = join(import.meta.dirname, "dist");
const rendererPath = join(outputDirectory, "renderer.js");
const [
  main,
  preload,
  rendererBuffer,
  html,
  styles,
  mainSource,
  preloadSource,
  rendererSource,
  supportedProtocolsSource,
] = await Promise.all([
  readFile(join(outputDirectory, "main.js"), "utf8"),
  readFile(join(outputDirectory, "preload.cjs"), "utf8"),
  readFile(rendererPath),
  readFile(join(outputDirectory, "index.html"), "utf8"),
  readFile(join(outputDirectory, "styles.css"), "utf8"),
  readFile(join(import.meta.dirname, "main.ts"), "utf8"),
  readFile(join(import.meta.dirname, "preload.ts"), "utf8"),
  readFile(join(import.meta.dirname, "renderer.ts"), "utf8"),
  readFile(join(import.meta.dirname, "supported-protocols.ts"), "utf8"),
]);
const renderer = rendererBuffer.toString("utf8");
const rendererRawBudget = 550 * 1024;
const rendererGzipBudget = 90 * 1024;

assert.match(main, /preload\.cjs/);
assert.match(main, /sandbox:\s*true/);
assert.match(main, /nodeIntegration:\s*false/);
assert.match(main, /contextIsolation:\s*true/);
assert.match(main, /getRuntimeProtocolCapabilities/);
assert.doesNotMatch(main, /\[\s*"1\.\d"(?:\s*,\s*"1\.\d")*\s*\]/);
assert.match(main, /isElectronRuntimeProtocolVersion/);
assert.match(main, /normalizeUserInputResult/);
assert.match(main, /onUserInputRequest/);
assert.match(mainSource, /did-start-navigation/);
assert.match(mainSource, /render-process-gone/);
assert.match(mainSource, /documentGeneration/);
assert.match(mainSource, /RendererInteractionRegistry/);
assert.match(preload, /require\(["']electron["']\)/);
assert.doesNotMatch(preload, /^\s*import\s/m);
assert.match(preloadSource, /RuntimeMethodResultForVersion/);
assert.match(preloadSource, /ElectronRuntimeProtocolVersion/);
assert.match(supportedProtocolsSource, /getRuntimeProtocolCapabilities\(value\)\.serverRequests/);
assert.match(preloadSource, /onUserInputRequest/);
assert.doesNotMatch(preloadSource, /snapshotThread[\s\S]*?RuntimeMethodResult<"thread\.snapshot">/);
assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^\n]*ipcRenderer/);
assert.doesNotMatch(preloadSource, /String\(error\)/);
const rollRendererApi = /export interface RollRendererApi \{([\s\S]*?)\n\}/.exec(preloadSource);
assert.notEqual(rollRendererApi, null);
assert.doesNotMatch(rollRendererApi[1], /ipcRenderer/);
assert.doesNotMatch(rollRendererApi[1], /\n\s*request\s*\(/);
assert.doesNotMatch(renderer, /window\.confirm/);
assert.match(renderer, /\.showModal\(\)/);
assert.match(renderer, /addEventListener\(["']abort["']/);
assert.match(renderer, /normalizeUserInputResult/);
assert.doesNotMatch(rendererSource, /innerHTML/);
assert.doesNotMatch(rendererSource, /JSON\.stringify\(result/);
assert.match(rendererSource, /createElement\("input"\)/);
assert.match(rendererSource, /createElement\("textarea"\)/);
for (const controlType of ["text", "multiline", "number", "boolean", "choice"]) {
  assert.match(rendererSource, new RegExp(`USER_INPUT_CONTROL_TYPES\\.${controlType}`));
}
assert.match(html, /Content-Security-Policy/);
assert.match(html, /src="\.\/renderer\.js"/);
assert.match(html, /href="\.\/styles\.css"/);
assert.match(html, /<dialog id="approval-dialog"/);
assert.match(html, /id="approval-explanation"/);
assert.match(html, /<dialog id="user-input-dialog"/);
assert.match(html, /id="user-input-controls"/);
assert.match(styles, /#approval-dialog/);
assert.match(styles, /#user-input-dialog/);
assert.match(renderer, /getApprovalExplanation/);
assert.match(renderer, /explanation\.hidden\s*=\s*explanationText\s*===\s*void 0/);
assert.match(renderer, /This tool requires your approval\./);
assert.ok(
  rendererBuffer.byteLength <= rendererRawBudget,
  `renderer.js exceeds raw budget: ${String(rendererBuffer.byteLength)} > ${String(rendererRawBudget)}`,
);
const rendererGzipBytes = gzipSync(rendererBuffer).byteLength;
assert.ok(
  rendererGzipBytes <= rendererGzipBudget,
  `renderer.js exceeds gzip budget: ${String(rendererGzipBytes)} > ${String(rendererGzipBudget)}`,
);

const registryTest = spawnSync(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    "--test",
    join(import.meta.dirname, "renderer-interaction-registry.test.ts"),
  ],
  {
    cwd: join(import.meta.dirname, "../.."),
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: "inherit",
  },
);
assert.equal(registryTest.status, 0, "renderer interaction registry tests failed");

console.log(
  `ELECTRON_RUNTIME_CLIENT_BUILD_OK renderer_raw=${String(rendererBuffer.byteLength)} renderer_gzip=${String(rendererGzipBytes)}`,
);
