import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowStore, type WorkflowDraftInput } from "./store.ts";

const draft: WorkflowDraftInput = {
  id: "example-search",
  name: "Example search",
  description: "Search the example site",
  source: 'return await browser.text({css:"h1"});',
  appliesTo: { origins: ["https://example.com"], pathPrefix: "/search" },
  allowedOrigins: ["https://example.com"],
  capabilities: ["read"],
  parameterSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
  postconditions: [{ kind: "visible", target: { css: "h1" } }],
};
const receipt = {
  compiled: true,
  success: true,
  verifiedAssertions: 1,
  executionDigest: "a".repeat(64),
} as const;

test("drafts need exact-version validation and explicit activation; revisions are isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-workflows-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new WorkflowStore({ root });
  const first = await store.saveDraft(draft);
  assert.equal(first.state.status, "draft");
  assert.deepEqual(await store.listApplicableActive("https://example.com/search"), []);
  await assert.rejects(store.setStatus(draft.id, first.version, "active"), /Activation requires/);
  await store.recordValidation(draft.id, first.version, receipt);
  await store.setStatus(draft.id, first.version, "active");
  assert.equal((await store.listApplicableActive("https://example.com/search?q=test")).length, 1);
  assert.deepEqual(await store.listApplicableActive("https://other.example/search"), []);
  assert.deepEqual(await store.listApplicableActive("https://example.com/account"), []);
  const next = await store.saveDraft({ ...draft, source: `${draft.source}\n// revision` });
  assert.notEqual(next.version, first.version);
  assert.equal(next.state.status, "draft");
  assert.deepEqual(next.state.validations, []);
  await assert.rejects(store.setStatus(draft.id, next.version, "active"));
  assert.equal((await store.saveDraft(draft)).state.status, "active");
  await store.setStatus(draft.id, first.version, "disabled");
  assert.deepEqual(await store.listApplicableActive("https://example.com/search"), []);
  await store.setStatus(draft.id, first.version, "active");
  await store.setStatus(draft.id, first.version, "suspended");
  assert.deepEqual(await store.listApplicableActive("https://example.com/search"), []);
});

test("concurrent saves and validation writes preserve versions and bounded receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-workflows-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const stores = [new WorkflowStore({ root }), new WorkflowStore({ root })];
  const versions = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => await stores[index % 2]!.saveDraft(draft)),
  );
  assert.equal(new Set(versions.map((item) => item.version)).size, 1);
  const version = versions[0]!.version;
  await Promise.all(
    Array.from(
      { length: 12 },
      async (_, index) =>
        await stores[index % 2]!.recordValidation(draft.id, version, {
          ...receipt,
          executionDigest: index.toString(16).padStart(64, "0"),
        }),
    ),
  );
  assert.equal((await stores[0]!.getVersion(draft.id, version)).state.validations.length, 10);
  const files = await readdir(join(root, draft.id));
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.doesNotMatch(
      await readFile(join(root, draft.id, file), "utf8"),
      /runtimeArgs|messageBody|cookieValue/,
    );
  }
  await assert.rejects(
    stores[0]!.recordValidation(draft.id, version, {
      ...receipt,
      runtimeArgs: "secret",
    } as typeof receipt),
    /unrecognized/i,
  );
});

test("reject traversal, symlinks and modified immutable contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "roll-workflows-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new WorkflowStore({ root });
  await assert.rejects(store.saveDraft({ ...draft, id: "../escape" }));
  const version = await store.saveDraft(draft);
  const path = join(root, draft.id, `${version.version}.json`);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  parsed.draft.source = "return 'tampered'";
  await writeFile(path, JSON.stringify(parsed));
  await assert.rejects(store.getVersion(draft.id, version.version), /hash mismatch/);
  await symlink(join(root, draft.id), join(root, "linked"));
  await assert.rejects(store.saveDraft({ ...draft, id: "linked" }), /symlink/);
  await rm(path);
  await symlink(join(root, "external.json"), path);
  await assert.rejects(store.getVersion(draft.id, version.version));
});
