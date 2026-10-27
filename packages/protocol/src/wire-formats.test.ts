import assert from "node:assert/strict";
import { test } from "node:test";
import { threadIdSchema, timestampSchema, uuidSchema } from "./index.ts";

test("wire UUID validation preserves nil and versioned IDs without admitting the max UUID", () => {
  for (const schema of [uuidSchema, threadIdSchema]) {
    for (const value of [
      "00000000-0000-0000-0000-000000000000",
      "d2df3c50-10de-4efd-9199-a0f7d5dd323c",
    ]) {
      assert.equal(schema.safeParse(value).success, true, value);
    }
    for (const value of [
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "d2df3c50-10de-0efd-9199-a0f7d5dd323c",
      "bad",
    ]) {
      assert.equal(schema.safeParse(value).success, false, value);
    }
  }
});

test("wire timestamps retain minute precision, offsets and calendar validation", () => {
  for (const value of ["2024-02-29T12:00Z", "2026-10-27T12:00+08:00", "2026-10-27T12:00:00.123Z"]) {
    assert.equal(timestampSchema.safeParse(value).success, true, value);
  }
  for (const value of ["2025-02-29T12:00Z", "2026-10-27T24:00Z", "2026-10-27T12:00", "bad"]) {
    assert.equal(timestampSchema.safeParse(value).success, false, value);
  }
});
