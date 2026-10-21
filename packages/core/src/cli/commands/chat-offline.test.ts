import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatGptCredentialStore } from "../../auth/chatgpt/storage.ts";

test(
  "actual CLI enters basic chat with expired credentials offline and stays alive after reconnect failure",
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-cli-offline-"));
    const authStore = new ChatGptCredentialStore(join(dir, ".roll-agent", "auth", "chatgpt"));
    const hostId = await authStore.hostId();
    const id = "00000000-0000-4000-8000-000000000001";
    authStore.save({
      id,
      clientId: "fixture-client",
      hostId,
      credentials: {
        accessToken: "synthetic",
        refreshToken: "synthetic",
        idToken: "synthetic",
        expiresAt: 1,
        savedAt: 0,
        scopes: ["chatgpt.tokens.use.direct"],
      },
    });
    await authStore.setCurrent(id);
    writeFileSync(
      join(dir, "roll.config.yaml"),
      JSON.stringify({
        ask: {},
        agents: { dataDir: join(dir, "agents") },
        llm: { defaultProvider: "chatgpt", defaultModel: "fixture", providers: {} },
        runtime: { provider: "chatgpt", model: "fixture", threadsDir: join(dir, "threads") },
        chat: { instructions: "off" },
      }),
    );
    const preload = join(dir, "isolate.mjs");
    // Isolate all homedir consumers in this child without changing the user's environment/config.
    writeFileSync(
      preload,
      `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(dir)};
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new TypeError('fetch failed', {cause: {code:'ECONNRESET'}}); };
`,
    );
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-sqlite",
        "--import",
        preload,
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        "chat",
        "--screen-mode",
        "inline",
      ],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let failures = 0;
    let entered = false;
    const result = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const watchdog = setTimeout(() => child.kill(), 15000);
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      entered ||= output.includes("进入多轮对话");
      const count = output.split("/reconnect 重试连接").length - 1;
      if (count > failures) {
        failures = count;
        child.stdin.write(failures === 1 ? "/reconnect\n" : "exit\n");
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    try {
      assert.equal(await result, 0, output);
      assert.equal(entered, true, output);
      assert.equal(failures, 2, output);
      assert.doesNotMatch(output, /正在连接 ChatGPT|ChatGPT 已连接|ChatGPT 尚未连接/);
      assert.match(output, /网络中断.*\/reconnect/);
      assert.doesNotMatch(output, /ECONNRESET|fetch failed/);
      assert.doesNotMatch(output, /synthetic/);
      assert.equal(authStore.read(id)?.credentials?.refreshToken, "synthetic");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
