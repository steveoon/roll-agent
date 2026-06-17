import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  buildNpmRetryPolicy,
  createPackageManagerExecInvocation,
  createInstallCommand,
  detectInstallCommand,
  formatPackageManagerCommand,
  formatPackageManagerError,
  isLikelyNetworkError,
  isLikelyRollAgentRegistryPropagationError,
  isRetryablePackageManagerError,
  npmInstallNetworkArgs,
  npmViewNetworkArgs,
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

  test("appends mirror-source hint for network errors", () => {
    const error = Object.assign(new Error("network request to https://registry.npmjs.org failed"), {
      code: "ETIMEDOUT",
    });

    const message = formatPackageManagerError(
      { command: "npm", args: ["install", "--prefix", "/tmp/x", "left-pad"] },
      error,
      "linux",
    );
    assert.match(message, /install\.registry/);
    assert.match(message, /registry\.npmmirror\.com/);
  });

  test("formats timeout-kill as a network-flavored failure", () => {
    const error = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });

    const message = formatPackageManagerError(
      { command: "npm", args: ["install"] },
      error,
      "linux",
    );
    assert.match(message, /超时被终止/);
    assert.match(message, /install\.registry/);
  });
});

describe("package-manager — Windows shell resolution", () => {
  test("prefers ComSpec when set on win32", () => {
    const original = process.env["ComSpec"];
    process.env["ComSpec"] = "D:\\custom\\cmd.exe";
    try {
      const invocation = createPackageManagerExecInvocation(
        { command: "npm", args: ["install", "left-pad"] },
        "win32",
      );
      assert.equal(invocation.file, "D:\\custom\\cmd.exe");
    } finally {
      if (original === undefined) {
        delete process.env["ComSpec"];
      } else {
        process.env["ComSpec"] = original;
      }
    }
  });

  test("falls back to cmd.exe when ComSpec is empty on win32", () => {
    const original = process.env["ComSpec"];
    delete process.env["ComSpec"];
    try {
      const invocation = createPackageManagerExecInvocation(
        { command: "npm", args: ["install", "left-pad"] },
        "win32",
      );
      assert.equal(invocation.file, "cmd.exe");
    } finally {
      if (original !== undefined) {
        process.env["ComSpec"] = original;
      }
    }
  });
});

describe("package-manager — npm network args", () => {
  test("install args always include --no-audit/--no-fund", () => {
    assert.deepEqual(npmInstallNetworkArgs(), ["--no-audit", "--no-fund"]);
  });

  test("install args include registry, fetch-retries and prefer-offline when set", () => {
    assert.deepEqual(
      npmInstallNetworkArgs({
        registry: "https://registry.npmmirror.com",
        fetchRetries: 5,
        preferOffline: true,
      }),
      [
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmmirror.com",
        "--fetch-retries=5",
        "--prefer-offline",
      ],
    );
  });

  test("view args only add registry and fetch-retries", () => {
    assert.deepEqual(
      npmViewNetworkArgs({ registry: "https://registry.npmmirror.com", fetchRetries: 2 }),
      ["--registry=https://registry.npmmirror.com", "--fetch-retries=2"],
    );
    assert.deepEqual(npmViewNetworkArgs(), []);
  });
});

describe("package-manager — error classification & retry", () => {
  test("recognizes network error codes and messages", () => {
    assert.equal(isLikelyNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
    assert.equal(isLikelyNetworkError(new Error("getaddrinfo ENOTFOUND registry")), true);
    assert.equal(isLikelyNetworkError(new Error("npm error code E429")), true);
    assert.equal(isLikelyNetworkError(new Error("npm ERR! code E429")), true);
    assert.equal(isLikelyNetworkError(new Error("npm error code E404")), false);
    assert.equal(isLikelyNetworkError(new Error("npm error code E401")), false);
    assert.equal(isLikelyNetworkError(new Error("ERR_PNPM_NO_MATCHING_VERSION")), false);
  });

  test("recognizes transient @roll-agent registry 404 during package propagation", () => {
    const error = new Error(
      [
        "npm error code E404",
        "npm error 404 Not Found - GET https://registry.npmjs.org/@roll-agent%2fruntime - Not found",
        "npm error 404  '@roll-agent/runtime@0.1.0' is not in this registry.",
      ].join("\n"),
    );

    assert.equal(isLikelyNetworkError(error), false);
    assert.equal(isLikelyRollAgentRegistryPropagationError(error), true);
    assert.equal(isRetryablePackageManagerError(error), true);
  });

  test("does not retry generic npm 404 package misses", () => {
    const error = new Error(
      [
        "npm error code E404",
        "npm error 404 Not Found - GET https://registry.npmjs.org/not-a-roll-package - Not found",
        "npm error 404  'not-a-roll-package@1.0.0' is not in this registry.",
      ].join("\n"),
    );

    assert.equal(isLikelyRollAgentRegistryPropagationError(error), false);
    assert.equal(isRetryablePackageManagerError(error), false);
  });

  test("retryable covers network errors and timeout kills", () => {
    assert.equal(
      isRetryablePackageManagerError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
      true,
    );
    assert.equal(
      isRetryablePackageManagerError(
        Object.assign(new Error("Command failed"), {
          killed: true,
          signal: "SIGTERM",
          code: null,
        }),
      ),
      true,
    );
    assert.equal(isRetryablePackageManagerError(new Error("ENOENT")), false);
  });

  test("retry policy caps total attempts at 3", () => {
    assert.equal(buildNpmRetryPolicy(0).attempts, 1);
    assert.equal(buildNpmRetryPolicy(1).attempts, 2);
    assert.equal(buildNpmRetryPolicy(3).attempts, 3);
    assert.equal(buildNpmRetryPolicy(10).attempts, 3);
    assert.deepEqual(buildNpmRetryPolicy(0).backoffMs, []);
    assert.deepEqual(buildNpmRetryPolicy(3).backoffMs, [2000, 5000]);
  });
});
