import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

test("current CLI shim normalizes only the Windows executable and disposes bridge files", () => {
  const root = testRoot();
  const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };
  try {
    const direct = installCurrentCliShim({
      executable: String.raw`\\?\C:\app\node.exe`,
      execArgv: [],
      entryPath: String.raw`\\?\C:\app\roll.js`,
      platform: "win32",
      tempRoot: root,
      env,
    });
    assert.ok(
      readFileSync(direct.path, "utf8").includes('"C:\\app\\node.exe" "\\\\?\\C:\\app\\roll.js"'),
    );
    assert.equal(existsSync(join(dirname(direct.path), "launch.ps1")), false);
    const bridge = installCurrentCliShim({
      executable: String.raw`\\?\C:\app.\node.exe`,
      execArgv: ["--inspect", "--no-warnings"],
      entryPath: String.raw`C:\app\roll.js`,
      platform: "win32",
      tempRoot: root,
      env,
    });
    assert.equal(existsSync(join(dirname(bridge.path), "launch.ps1")), true);
    direct.dispose();
    assert.equal(env.ROLL_CURRENT_CLI, bridge.path);
    bridge.dispose();
    assert.equal(existsSync(dirname(bridge.path)), false);
    assert.equal(env.Path, "C:\\Windows\\System32");
    assert.equal(env.ROLL_CURRENT_CLI, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current CLI shim 在 Windows 忽略空 SystemRoot 并回退", () => {
  const root = testRoot();
  const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32", SystemRoot: "   " };
  try {
    const shim = installCurrentCliShim({
      executable: "C:\\Users\\中文\\node.exe",
      execArgv: [],
      entryPath: "C:\\Users\\中文\\cli.js",
      env,
      platform: "win32",
      tempRoot: root,
    });
    assert.equal(existsSync(join(dirname(shim.path), "launch.ps1")), true);
    assert.match(
      readFileSync(shim.path, "utf8"),
      /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/iu,
    );
    shim.dispose();
    assert.equal(env.Path, "C:\\Windows\\System32");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "current CLI shim 在临时目录无法删除时仍恢复环境且不抛错",
  { skip: process.platform !== "win32" && process.getuid?.() === 0 },
  async () => {
    const root = testRoot();
    if (process.platform === "win32") {
      const env: NodeJS.ProcessEnv = {
        Path: "C:\\Windows\\System32",
        ROLL_CURRENT_CLI: "C:\\previous\\roll.cmd",
      };
      const psExe = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      let holder: ReturnType<typeof spawn> | undefined;
      try {
        const shim = installCurrentCliShim({
          executable: "C:\\Users\\中文\\node.exe",
          execArgv: [],
          entryPath: "C:\\Users\\中文\\cli.js",
          env,
          platform: "win32",
          tempRoot: root,
        });
        holder = spawn(
          psExe,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$s = [IO.File]::Open(${JSON.stringify(shim.path)}, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 10`,
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        await new Promise<void>((resolve, reject) => {
          holder?.stdout?.on("data", (chunk: Buffer) => {
            if (chunk.toString("utf8").includes("LOCKED")) resolve();
          });
          holder?.once("error", reject);
        });
        assert.doesNotThrow(() => {
          shim.dispose();
        });
        assert.equal(env.Path, "C:\\Windows\\System32");
        assert.equal(env.ROLL_CURRENT_CLI, "C:\\previous\\roll.cmd");
        assert.equal(existsSync(shim.path), true);
      } finally {
        if (holder && holder.exitCode === null) {
          holder.kill();
          await new Promise((resolve) => holder?.once("exit", resolve));
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      return;
    }

    const env: NodeJS.ProcessEnv = { PATH: "/old/bin", ROLL_CURRENT_CLI: "/previous/roll" };
    try {
      const shim = installCurrentCliShim({
        executable: "/path/to/node",
        execArgv: [],
        entryPath: "/workspace/cli.ts",
        env,
        platform: "linux",
        tempRoot: root,
      });
      chmodSync(root, 0o500);
      try {
        assert.doesNotThrow(() => {
          shim.dispose();
        });
        assert.equal(env.PATH, "/old/bin");
        assert.equal(env.ROLL_CURRENT_CLI, "/previous/roll");
      } finally {
        chmodSync(root, 0o700);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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
