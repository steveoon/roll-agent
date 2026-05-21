import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLastJson } from "./roll-json-extract.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runHelper(name, input, args = []) {
  return spawnSync("node", [path.join(dir, name), ...args], {
    input,
    encoding: "utf8",
  });
}

assert.equal(extractLastJson('noise {"a":1} tail {"b":2}'), '{"b":2}');

const unread = runHelper(
  "find-unread-ref.mjs",
  'stderr\n{"snapshot":{"refs":[{"name":"未读","ref":"@e32"}]}}\n',
);
assert.equal(unread.status, 0, unread.stderr);
assert.equal(unread.stdout.trim(), "@e32");

const unreadFallback = runHelper(
  "find-unread-ref.mjs",
  'broken {"name":"未读tab","ref":"@e99"} more garbage',
);
assert.equal(unreadFallback.status, 0, unreadFallback.stderr);
assert.equal(unreadFallback.stdout.trim(), "@e99");

const read = runHelper(
  "parse-read-candidate.mjs",
  JSON.stringify({
    candidates: [{ conversationId: "c1", name: "Li", preview: "hi" }],
    page: { url: "https://example.com", title: "t" },
  }),
);
assert.equal(read.status, 0);
assert.deepEqual(JSON.parse(read.stdout), {
  conversationId: "c1",
  name: "Li",
  preview: "hi",
  pageUrl: "https://example.com",
  pageTitle: "t",
});

const expired = runHelper("detect-expired-banner.mjs", "banner 沟通职位已到期 here");
assert.equal(expired.stdout.trim(), "expired");

const captcha = runHelper(
  "parse-page-meta.mjs",
  JSON.stringify({ page: { url: "https://x/verify.html", title: "安全验证" } }),
);
assert.equal(JSON.parse(captcha.stdout).captcha, true);

const multiInstanceNoSelection = runHelper(
  "validate-browser-selection.mjs",
  JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
);
assert.equal(multiInstanceNoSelection.status, 1);
assert.match(multiInstanceNoSelection.stderr, /pass --browser-instance/);

const explicitSelection = spawnSync("node", [path.join(dir, "validate-browser-selection.mjs")], {
  input: JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
  encoding: "utf8",
  env: { ...process.env, ROLL_BROWSER_INSTANCE: "boss-b" },
});
assert.equal(explicitSelection.status, 0, explicitSelection.stderr);

const missingSelection = spawnSync("node", [path.join(dir, "validate-browser-selection.mjs")], {
  input: JSON.stringify({
    defaultInstanceId: null,
    instances: [{ id: "boss-a" }, { id: "boss-b" }],
  }),
  encoding: "utf8",
  env: { ...process.env, ROLL_BROWSER_INSTANCE: "boss-x" },
});
assert.equal(missingSelection.status, 1);
assert.match(missingSelection.stderr, /not declared/);

const failedStatusShape = runHelper(
  "validate-browser-selection.mjs",
  JSON.stringify({ ok: false, error: "browserInstance is unknown" }),
);
assert.equal(failedStatusShape.status, 1);
assert.match(failedStatusShape.stderr, /instances array/);

console.log("roll-helpers.test.mjs: ok");
