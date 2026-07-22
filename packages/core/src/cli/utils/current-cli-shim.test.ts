import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { installCurrentCliShim } from "./current-cli-shim.ts";

function testRoot(): string {
  return mkdtempSync(join(tmpdir(), "roll-current-cli-test-"));
}

const posixOnly = { skip: process.platform === "win32" };

test("current CLI shim 转发参数并在 dispose 后恢复环境", posixOnly, () => {
  const root = testRoot();
  const entryPath = join(root, "entry.mjs");
  writeFileSync(entryPath, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const env: NodeJS.ProcessEnv = { PATH: "/old/bin", ROLL_CURRENT_CLI: "/previous/roll" };
  try {
    const shim = installCurrentCliShim({
      executable: process.execPath,
      execArgv: [],
      entryPath,
      env,
      platform: "linux",
      tempRoot: root,
    });
    const shimDirectory = dirname(shim.path);

    assert.equal(env.ROLL_CURRENT_CLI, shim.path);
    assert.equal(env.PATH, `${shimDirectory}:/old/bin`);
    const result = spawnSync(shim.path, ["hello world", "中文"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ["hello world", "中文"]);

    shim.dispose();
    shim.dispose();
    assert.equal(env.PATH, "/old/bin");
    assert.equal(env.ROLL_CURRENT_CLI, "/previous/roll");
    assert.equal(existsSync(shimDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI shim 不转发 inspect 参数", () => {
  const root = testRoot();
  try {
    const shim = installCurrentCliShim({
      executable: "/path/to/node",
      execArgv: ["--inspect=127.0.0.1:9229", "--inspect-brk", "--no-warnings"],
      entryPath: "/workspace/cli.ts",
      env: {},
      platform: "linux",
      tempRoot: root,
    });
    const source = readFileSync(shim.path, "utf8");
    assert.doesNotMatch(source, /--inspect/u);
    assert.match(source, /--no-warnings/u);
    shim.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI shim 将相对 preload 固定到启动目录", posixOnly, () => {
  const root = testRoot();
  const launchCwd = join(root, "launch");
  const childCwd = join(root, "child");
  mkdirSync(launchCwd);
  mkdirSync(childCwd);
  const hookPath = join(launchCwd, "hook.cjs");
  const entryPath = join(root, "entry.mjs");
  writeFileSync(hookPath, "process.env.ROLL_SHIM_HOOK = 'loaded';\n", "utf8");
  writeFileSync(entryPath, "console.log(process.env.ROLL_SHIM_HOOK ?? 'missing');\n", "utf8");
  try {
    const shim = installCurrentCliShim({
      executable: process.execPath,
      execArgv: ["--require", "./hook.cjs"],
      entryPath,
      env: {},
      launchCwd,
      platform: "linux",
      tempRoot: root,
    });
    const result = spawnSync(shim.path, [], {
      cwd: childCwd,
      encoding: "utf8",
      env: process.env,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "loaded");
    assert.match(readFileSync(shim.path, "utf8"), new RegExp(hookPath.replaceAll("/", "\\/"), "u"));
    shim.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI shim 非 LIFO 清理不会恢复已经删除的 shim", () => {
  const root = testRoot();
  const env: NodeJS.ProcessEnv = { PATH: "/base/bin" };
  try {
    const first = installCurrentCliShim({
      executable: "/path/to/node",
      execArgv: [],
      entryPath: "/workspace/cli.ts",
      env,
      platform: process.platform,
      tempRoot: root,
    });
    const second = installCurrentCliShim({
      executable: "/path/to/node",
      execArgv: [],
      entryPath: "/workspace/cli.ts",
      env,
      platform: process.platform,
      tempRoot: root,
    });

    first.dispose();
    assert.equal(env.ROLL_CURRENT_CLI, second.path);
    assert.equal((env.PATH ?? "").split(delimiter).includes(dirname(first.path)), false);
    assert.equal((env.PATH ?? "").split(delimiter).includes(dirname(second.path)), true);

    second.dispose();
    assert.equal(env.PATH, "/base/bin");
    assert.equal(env.ROLL_CURRENT_CLI, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI shim 在 Windows 使用现有 Path 键并生成 cmd", () => {
  const root = testRoot();
  const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };
  try {
    const shim = installCurrentCliShim({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      execArgv: ["--experimental-strip-types"],
      entryPath: "C:\\workspace\\packages\\core\\src\\cli\\index.ts",
      env,
      platform: "win32",
      tempRoot: root,
    });
    assert.match(shim.path, /roll\.cmd$/u);
    assert.equal(env.PATH, undefined);
    assert.ok(env.Path?.startsWith(`${dirname(shim.path)};`));
    const source = readFileSync(shim.path, "utf8");
    assert.match(source, /^@echo off\r?$/mu);
    assert.match(source, /experimental-strip-types/u);
    shim.dispose();
    assert.equal(env.Path, "C:\\Windows\\System32");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "current CLI shim 在 Windows 真正转发参数与退出码",
  { skip: process.platform !== "win32" },
  () => {
    const root = testRoot();
    const entryPath = join(root, "entry.mjs");
    writeFileSync(
      entryPath,
      "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;\n",
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    try {
      const shim = installCurrentCliShim({ env, entryPath, execArgv: [] });
      const result = spawnSync(`"${shim.path}" "hello world" "中文"`, {
        encoding: "utf8",
        env,
        shell: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()), ["hello world", "中文"]);
      shim.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
