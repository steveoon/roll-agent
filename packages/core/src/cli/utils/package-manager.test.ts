import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  createPackageManagerExecInvocation,
  createInstallCommand,
  detectInstallCommand,
  formatPackageManagerCommand,
  formatPackageManagerError,
  shouldRunPackageManagerViaShell,
} from "./package-manager.ts";

describe("package-manager — detectInstallCommand", () => {
  test("prefers packageManager from package.json", () => {
    const tmpPath = resolve(tmpdir(), `roll-package-manager-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(
        resolve(tmpPath, "package.json"),
        JSON.stringify({ packageManager: "yarn@4.9.1" }, null, 2),
        "utf-8",
      );
      writeFileSync(resolve(tmpPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf-8");

      assert.deepEqual(detectInstallCommand(tmpPath), {
        command: "yarn",
        args: ["install"],
      });
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("falls back to pnpm lockfile", () => {
    const tmpPath = resolve(tmpdir(), `roll-package-manager-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(resolve(tmpPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf-8");

      assert.deepEqual(detectInstallCommand(tmpPath), {
        command: "pnpm",
        args: ["install"],
      });
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  test("returns undefined when no package manager hints exist", () => {
    const tmpPath = resolve(tmpdir(), `roll-package-manager-${randomUUID()}`);
    mkdirSync(tmpPath, { recursive: true });

    try {
      writeFileSync(resolve(tmpPath, "package.json"), JSON.stringify({ name: "foo" }), "utf-8");
      assert.equal(detectInstallCommand(tmpPath), undefined);
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});

describe("package-manager — run policy", () => {
  test("uses shell only on Windows", () => {
    assert.equal(shouldRunPackageManagerViaShell("win32"), true);
    assert.equal(shouldRunPackageManagerViaShell("darwin"), false);
    assert.equal(shouldRunPackageManagerViaShell("linux"), false);
  });

  test("creates pnpm install command by default", () => {
    assert.deepEqual(createInstallCommand(), {
      command: "pnpm",
      args: ["install"],
    });
  });

  test("keeps argv separate on macOS and Linux", () => {
    assert.deepEqual(
      createPackageManagerExecInvocation(
        {
          command: "npm",
          args: ["install", "--prefix", "/tmp/path with space", "left-pad"],
        },
        "linux",
      ),
      {
        file: "npm",
        args: ["install", "--prefix", "/tmp/path with space", "left-pad"],
        shell: false,
      },
    );
  });

  test("quotes Windows shell command args", () => {
    assert.deepEqual(
      createPackageManagerExecInvocation(
        {
          command: "npm",
          args: ["install", "--prefix", "C:\\Users\\Name With Space\\npm", "pkg&echo bad"],
        },
        "win32",
      ),
      {
        file: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          'npm install --prefix "C:\\Users\\Name With Space\\npm" "pkg^&echo bad"',
        ],
        shell: false,
      },
    );
  });

  test("escapes Windows variable expansion syntax", () => {
    assert.deepEqual(
      createPackageManagerExecInvocation(
        {
          command: "npm",
          args: ["view", "pkg%PATH%!"],
        },
        "win32",
      ),
      {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", 'npm view "pkg^%PATH^%^!"'],
        shell: false,
      },
    );
  });
});

describe("package-manager — formatting", () => {
  test("quotes display args containing whitespace", () => {
    assert.equal(
      formatPackageManagerCommand({
        command: "npm",
        args: ["install", "--prefix", "C:\\Users\\Name With Space\\AppData\\Roaming"],
      }),
      'npm install --prefix "C:\\\\Users\\\\Name With Space\\\\AppData\\\\Roaming"',
    );
  });

  test("formats ENOENT as command-not-found guidance", () => {
    const error = Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });

    assert.match(
      formatPackageManagerError({ command: "pnpm", args: ["install"] }, error, "linux"),
      /未找到 pnpm/,
    );
  });

  test("formats Windows shell command-not-found guidance", () => {
    const error = new Error("'pnpm' is not recognized as an internal or external command");

    assert.match(
      formatPackageManagerError({ command: "pnpm", args: ["install"] }, error, "win32"),
      /pnpm\.cmd/,
    );
  });
});
