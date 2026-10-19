import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("ask still reaches API-key routing when runtime defaults to subscription", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-ask-subscription-"));
  try {
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({
        llm: {
          defaultProvider: "openai",
          defaultModel: "gpt-api",
          providers: { openai: { apiKey: "fixture" } },
        },
        runtime: { provider: "chatgpt", model: "subscription-slug" },
        agents: { dataDir: join(dir, "agents") },
      }),
    );
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--experimental-sqlite",
          fileURLToPath(new URL("../index.ts", import.meta.url)),
          "ask",
          "fixture",
        ],
        { cwd: dir },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), /暂无已注册的 Agent/);
        assert.doesNotMatch(String(error.stderr), /暂不支持 roll ask|选择 API Key provider/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
