import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { SUPPORTED_RUNTIME_PROTOCOL_VERSIONS } from "./index.ts";

const exportsMapSchema = z.record(z.unknown());
const manifestSchema = z.object({
  exports: exportsMapSchema,
  publishConfig: z.object({ exports: exportsMapSchema }),
});

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);

test("every supported Runtime Protocol version has a schema subpath export", () => {
  for (const [label, exportsMap] of [
    ["exports", manifest.exports],
    ["publishConfig.exports", manifest.publishConfig.exports],
  ] as const) {
    for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS) {
      assert.equal(
        exportsMap[`./schema/${version}`],
        `./dist/schema/roll-runtime-protocol-v${version}.schema.json`,
        `${label} 缺少 ./schema/${version}`,
      );
    }
  }
});
