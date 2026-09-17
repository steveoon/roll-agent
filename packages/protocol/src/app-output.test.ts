import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAppOutputContract } from "./app-output.ts";

const declaration = { schemaId: "test.output", schemaVersion: 1 };
test("application contracts accept local recursion and property names that look like keywords", () => {
  const outputSchema = {
    type: "object",
    properties: { $ref: { type: "string" }, child: { $ref: "#" } },
  };
  const contract = validateAppOutputContract({ ...declaration, outputSchema });
  assert.deepEqual(contract, { ...declaration, remoteReadable: false, outputSchema });
});
test("application contracts reject unresolvable, dynamic, external and nested-id references", () => {
  for (const child of [
    { $ref: "#/missing" },
    { $ref: "http://example.test/schema" },
    { $dynamicRef: "#" },
    { type: "object", $id: "other", properties: { item: { $ref: "#" } } },
  ]) {
    assert.throws(() =>
      validateAppOutputContract({
        ...declaration,
        outputSchema: { type: "object", properties: { child } },
      }),
    );
  }
});
test("application schema limit is measured in UTF-8 bytes and nonobject roots fail", () => {
  assert.throws(
    () =>
      validateAppOutputContract({
        ...declaration,
        outputSchema: { type: "object", description: "字".repeat(11000) },
      }),
    /32 KiB/,
  );
  assert.throws(
    () => validateAppOutputContract({ ...declaration, outputSchema: { type: "array" } }),
    /object/,
  );
});
