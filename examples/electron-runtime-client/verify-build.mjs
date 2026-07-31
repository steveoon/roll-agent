import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = join(import.meta.dirname, "dist");
const [main, preload, renderer, html, styles] = await Promise.all(
  ["main.js", "preload.cjs", "renderer.js", "index.html", "styles.css"].map((file) =>
    readFile(join(outputDirectory, file), "utf8"),
  ),
);

assert.match(main, /preload\.cjs/);
assert.match(main, /sandbox:\s*true/);
assert.match(main, /nodeIntegration:\s*false/);
assert.match(main, /contextIsolation:\s*true/);
assert.match(preload, /require\(["']electron["']\)/);
assert.doesNotMatch(preload, /^\s*import\s/m);
assert.doesNotMatch(renderer, /window\.confirm/);
assert.match(renderer, /\.showModal\(\)/);
assert.match(renderer, /addEventListener\(["']abort["']/);
assert.match(html, /Content-Security-Policy/);
assert.match(html, /src="\.\/renderer\.js"/);
assert.match(html, /href="\.\/styles\.css"/);
assert.match(html, /<dialog id="approval-dialog"/);
assert.match(html, /id="approval-explanation"/);
assert.match(styles, /#approval-dialog/);
assert.match(renderer, /getApprovalExplanation/);
assert.match(renderer, /explanation\.hidden\s*=\s*explanationText\s*===\s*void 0/);
assert.match(renderer, /This tool requires your approval\./);

console.log("ELECTRON_RUNTIME_CLIENT_BUILD_OK");
