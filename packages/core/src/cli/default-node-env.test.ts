import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(new URL("./default-node-env.ts", import.meta.url));

function nodeEnvAfterImport(env: Record<string, string | undefined>): string {
  const { NODE_ENV: _ignored, ...base } = process.env;
  return execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `import ${JSON.stringify(modulePath)}; process.stdout.write(String(process.env.NODE_ENV));`,
    ],
    { env: { ...base, ...env }, encoding: "utf8" },
  );
}

describe("default-node-env", () => {
  it("defaults NODE_ENV to production so React/Ink load their production builds", () => {
    assert.equal(nodeEnvAfterImport({}), "production");
  });

  it("keeps an explicitly configured NODE_ENV", () => {
    assert.equal(nodeEnvAfterImport({ NODE_ENV: "development" }), "development");
  });
});
