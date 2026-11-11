import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { cmdExecutablePath, renderWindowsCliFiles } from "./current-cli-windows.ts";

test("CMD executable conversion preserves ordinary drive and UNC paths", () => {
  for (const [input, expected] of [
    [String.raw`C:\Program Files\中文\node.exe`, String.raw`C:\Program Files\中文\node.exe`],
    [String.raw`\\?\C:\Program Files\node.exe`, String.raw`C:\Program Files\node.exe`],
    [String.raw`\\?\UNC\host\share\node.exe`, String.raw`\\host\share\node.exe`],
    [String.raw`\\?\unc\host\share\node.exe`, String.raw`\\host\share\node.exe`],
  ]) {
    assert.equal(cmdExecutablePath(input ?? ""), expected);
  }
});

test("CMD conversion declines namespace-dependent or ambiguous paths", () => {
  for (const input of [
    String.raw`\\?\Volume{123}\node.exe`,
    String.raw`\\.\C:\app\node.exe`,
    String.raw`\\?\C:\app.\node.exe`,
    String.raw`\\?\C:\app \node.exe`,
    String.raw`\\?\C:\app\..\node.exe`,
    String.raw`\\?\C:\app\.\node.exe`,
    String.raw`\\?\C:\NUL\node.exe`,
    String.raw`\\?\C:\CONIN$\node.exe`,
    String.raw`\\?\C:\CONOUT$\node.exe`,
    String.raw`\\?\C:\app/node.exe`,
    String.raw`\\?\C:\\app\node.exe`,
    String.raw`C:\app%PATH%\node.exe`,
    String.raw`C:\app!x!\node.exe`,
    String.raw`C:\app&x\node.exe`,
    String.raw`C:app\node.exe`,
    String.raw`..\node.exe`,
    `C:\\${"a\\".repeat(130)}node.exe`,
  ]) {
    assert.equal(cmdExecutablePath(input), undefined, input);
  }
});

test("ordinary namespaced executable uses CMD without rewriting entry or flags", () => {
  const entry = String.raw`\\?\C:\app\cli.js`;
  const files = renderWindowsCliFiles(
    [String.raw`\\?\C:\app\node.exe`, "--no-warnings", entry],
    String.raw`C:\Windows`,
  );
  assert.deepEqual(Object.keys(files), ["roll.cmd"]);
  assert.ok(files["roll.cmd"]?.includes(`"C:\\app\\node.exe" "--no-warnings" "${entry}" %*`));
});

test("shell-sensitive fixed arguments select data-only native bridge", () => {
  const command = [String.raw`C:\app\node.exe`, 'a%PATH%!&|<>^"b\\', "cli.js"];
  const files = renderWindowsCliFiles(command, String.raw`C:\Windows`);
  assert.deepEqual(Object.keys(files).sort(), ["launch.ps1", "roll.cmd"]);
  assert.ok(!files["launch.ps1"]?.includes(command[1] ?? ""));
  assert.match(files["launch.ps1"] ?? "", /GetCommandLineW/u);
});

test("native bridge rejects NUL instead of truncating a fixed argument", () => {
  assert.throws(
    () =>
      renderWindowsCliFiles(
        [String.raw`C:\app\node.exe`, "entry.mjs\0other"],
        String.raw`C:\Windows`,
      ),
    /NUL/u,
  );
});

test(
  "Windows direct CMD route preserves a fixed trailing backslash and caller arguments",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-direct-cli-test-"));
    try {
      const entry = join(root, "entry.mjs");
      writeFileSync(
        entry,
        "console.log(JSON.stringify({fixed:process.execArgv,args:process.argv.slice(2)}));process.exitCode=7;",
      );
      const fixed = ["--title=tail\\"];
      const files = renderWindowsCliFiles(
        [toNamespacedPath(process.execPath), ...fixed, entry],
        process.env.SystemRoot ?? "C:\\Windows",
      );
      assert.deepEqual(Object.keys(files), ["roll.cmd"]);
      writeFileSync(join(root, "roll.cmd"), files["roll.cmd"] ?? "");
      const result = spawnSync(`"${join(root, "roll.cmd")}" "" "hello world" "中文"`, {
        shell: true,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 7, result.stderr);
      const observed: unknown = JSON.parse(result.stdout);
      assert.deepEqual(observed, { fixed, args: ["", "hello world", "中文"] });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);

test(
  "Windows native bridge preserves argv, binary stdio and exit status at a deep executable",
  {
    skip: process.platform !== "win32",
    timeout: 60_000,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-native-cli-中文-"));
    const deep = join(
      root,
      ...Array.from({ length: 7 }, (_, index) => `deep-${index}-${"n".repeat(40)}`),
    );
    try {
      mkdirSync(toNamespacedPath(deep), { recursive: true });
      const executable = join(deep, "node.exe");
      assert.ok(executable.length > 260);
      copyFileSync(process.execPath, toNamespacedPath(executable));
      const specialDirectory = toNamespacedPath(join(root, "namespace-only. "));
      mkdirSync(specialDirectory);
      const specialExecutable = join(specialDirectory, "node.exe");
      copyFileSync(process.execPath, specialExecutable);
      const entry = join(root, "entry 中文 %!.mjs");
      const observed = join(root, "observed.json");
      writeFileSync(
        entry,
        `import{realpathSync,writeFileSync}from'node:fs';
writeFileSync(process.env.ROLL_ARGV_PROBE,JSON.stringify({args:process.argv.slice(2),execArgv:process.execArgv,cwd:realpathSync.native(process.cwd()),arch:process.arch,environment:{value:process.env.ROLL_FORWARD_PROBE,path:process.env.PATH}}));
const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{const b=Buffer.concat(chunks);process.stdout.write(b);process.stderr.write(b);process.exitCode=7;});`,
      );
      const args = [
        "",
        "hello world",
        "中文",
        'a"b',
        'a\\"b',
        '"outer \\"inner\\""',
        "tail\\",
        "two\\\\",
        "&|<>^%!",
        "--flag=value",
        "-File",
        "--%",
        "--",
        "",
      ];
      const quote = (value: string): string =>
        `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
      const input = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256));
      const execArgv = ['--title=fixed "quoted" %PATH%!\\'];
      const inheritedPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
      const inheritedValue = '中文 %!&="value"';
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
      );
      for (const path of [
        toNamespacedPath(executable),
        executable,
        specialExecutable,
        process.execPath,
        ...(toNamespacedPath(process.execPath).startsWith("\\\\?\\UNC\\")
          ? [
              toNamespacedPath(process.execPath),
              toNamespacedPath(process.execPath).replace("\\\\?\\UNC\\", "\\\\?\\unc\\"),
            ]
          : []),
      ]) {
        const files = renderWindowsCliFiles(
          [path, ...execArgv, entry],
          process.env.SystemRoot ?? "C:\\Windows",
        );
        for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
        // A raw CMD command exercises exactly the same %* boundary as nested roll tools.
        const result = spawnSync(`"${join(root, "roll.cmd")}" ${args.map(quote).join(" ")}`, {
          cwd: root,
          env: {
            ...inheritedEnv,
            Path: inheritedPath,
            ROLL_ARGV_PROBE: observed,
            ROLL_FORWARD_PROBE: inheritedValue,
          },
          shell: true,
          input,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 7, result.stderr.toString());
        assert.deepEqual(result.stdout, input);
        assert.deepEqual(result.stderr, input);
        const row: unknown = JSON.parse(readFileSync(observed, "utf8"));
        assert.deepEqual(row, {
          args,
          execArgv,
          cwd: realpathSync.native(root),
          arch: process.arch,
          environment: { value: inheritedValue, path: inheritedPath },
        });
      }
    } finally {
      await rm(toNamespacedPath(root), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  },
);
