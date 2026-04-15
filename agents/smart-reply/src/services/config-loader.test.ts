import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_REPLY_POLICY } from "../types/reply-policy.ts";

const REPLY_POLICY_PATH = join(import.meta.dirname, "../../data/reply-policy.json");

let originalReplyPolicyFile: string | undefined;
let hadOriginalReplyPolicyFile = false;

function backupReplyPolicyFile(): void {
  hadOriginalReplyPolicyFile = existsSync(REPLY_POLICY_PATH);
  if (hadOriginalReplyPolicyFile) {
    originalReplyPolicyFile = readFileSync(REPLY_POLICY_PATH, "utf-8");
  } else {
    originalReplyPolicyFile = undefined;
  }
}

function restoreReplyPolicyFile(): void {
  if (hadOriginalReplyPolicyFile && originalReplyPolicyFile !== undefined) {
    writeFileSync(REPLY_POLICY_PATH, originalReplyPolicyFile, "utf-8");
    return;
  }

  if (existsSync(REPLY_POLICY_PATH)) {
    unlinkSync(REPLY_POLICY_PATH);
  }
}

afterEach(() => {
  restoreReplyPolicyFile();
});

describe("loadReplyPolicy", () => {
  it("returns source=file after saveReplyPolicy updates the fresh cache", async () => {
    backupReplyPolicyFile();
    if (existsSync(REPLY_POLICY_PATH)) {
      unlinkSync(REPLY_POLICY_PATH);
    }

    const { loadReplyPolicy, saveReplyPolicy } = await import(
      `./config-loader.ts?case=${Date.now()}`
    );

    const fallbackResult = loadReplyPolicy();
    assert.equal(fallbackResult.source, "default");
    assert.deepEqual(fallbackResult.policy, DEFAULT_REPLY_POLICY);

    saveReplyPolicy(DEFAULT_REPLY_POLICY);

    const cachedResult = loadReplyPolicy();
    assert.equal(cachedResult.source, "file");
    assert.deepEqual(cachedResult.policy, DEFAULT_REPLY_POLICY);
  });
});
