import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

test("build archive paths use Windows extended paths without changing ZIP entry names", () => {
  const source = join(import.meta.dirname, "archive.py");
  const script = `
import runpy, sys
m=runpy.run_path(sys.argv[1]); extend=m['windows_extended_path']
assert extend('C:\\\\Users\\\\name\\\\file') == '\\\\\\\\?\\\\C:\\\\Users\\\\name\\\\file'
assert extend('\\\\\\\\server\\\\share\\\\file') == '\\\\\\\\?\\\\UNC\\\\server\\\\share\\\\file'
assert extend('\\\\\\\\?\\\\C:\\\\file') == '\\\\\\\\?\\\\C:\\\\file'
print('extended paths OK')
`;
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-c", script, source],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /extended paths OK/);
});
