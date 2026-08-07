import assert from "node:assert/strict";
import test from "node:test";
import { createPowerShellUtf8StringExpression } from "./windows-powershell.ts";

test("PowerShell string expressions encode syntax-sensitive path text", () => {
  const value = "C:\\Users\\O'Brien\\Roll Companion";
  const expression = createPowerShellUtf8StringExpression(value);
  assert.doesNotMatch(expression, /O'Brien/u);
  const encoded = /FromBase64String\('([^']+)'\)/u.exec(expression)?.[1];
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), value);
});
