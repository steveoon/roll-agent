import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";

test("public entrypoint bundles for browsers without Node builtins", async () => {
  const result = await build({
    entryPoints: [new URL("./index.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    write: false,
    metafile: true,
  });

  assert.equal(result.errors.length, 0);
  assert.ok(result.outputFiles.length > 0);
  const output = result.outputFiles.map((file) => file.text).join("\n");
  assert.doesNotMatch(output, /(?:from|import\()\s*["']node:/u);
  assert.doesNotMatch(output, /\b(?:Buffer|process\.env|require\()[\s.(]/u);
  const externalInputs = Object.entries(result.metafile.inputs).filter(([, input]) =>
    input.imports.some((entry) => entry.external),
  );
  assert.deepEqual(externalInputs, []);
});
