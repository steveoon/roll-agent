import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertSafeBrowserDataPath,
  buildBrowserDataClearPlan,
  clearBrowserDataTargets,
  resolveBrowserDataKinds,
} from "./browser-clear-data.ts";
import type { BrowserConfig } from "../../config/schema.ts";

test("resolveBrowserDataKinds defaults to profiles and sessions", () => {
  assert.deepEqual(resolveBrowserDataKinds({ all: false, profiles: false, sessions: false }), [
    "profiles",
    "sessions",
  ]);
  assert.deepEqual(resolveBrowserDataKinds({ all: false, profiles: false, sessions: true }), [
    "sessions",
  ]);
  assert.deepEqual(resolveBrowserDataKinds({ all: true, profiles: false, sessions: true }), [
    "profiles",
    "sessions",
  ]);
});

test("buildBrowserDataClearPlan includes profile and default per-instance sessions dir", () => {
  const config = createBrowserConfig({
    "boss-a": {
      userDataDir: "/tmp/roll-browser/profiles/boss-a",
      cdpPort: 9222,
    },
  });

  const plan = buildBrowserDataClearPlan(config, {
    kinds: ["profiles", "sessions"],
  });

  assert.deepEqual(
    plan.map((target) => ({
      instanceId: target.instanceId,
      kind: target.kind,
      path: target.path,
    })),
    [
      {
        instanceId: "boss-a",
        kind: "profiles",
        path: "/tmp/roll-browser/profiles/boss-a",
      },
      {
        instanceId: "boss-a",
        kind: "sessions",
        path: resolve(join(homedir(), ".roll-agent", "browser", "sessions", "boss-a")),
      },
    ],
  );
});

test("buildBrowserDataClearPlan can target one instance and sessions only", () => {
  const config = createBrowserConfig({
    "boss-a": {
      userDataDir: "/tmp/roll-browser/profiles/boss-a",
      sessionsDir: "/tmp/roll-browser/sessions/boss-a",
      cdpPort: 9222,
    },
    "boss-b": {
      userDataDir: "/tmp/roll-browser/profiles/boss-b",
      sessionsDir: "/tmp/roll-browser/sessions/boss-b",
      cdpPort: 9223,
    },
  });

  const plan = buildBrowserDataClearPlan(config, {
    instanceId: "boss-b",
    kinds: ["sessions"],
  });

  assert.deepEqual(
    plan.map((target) => ({
      instanceId: target.instanceId,
      kind: target.kind,
      path: target.path,
    })),
    [
      {
        instanceId: "boss-b",
        kind: "sessions",
        path: "/tmp/roll-browser/sessions/boss-b",
      },
    ],
  );
});

test("clearBrowserDataTargets removes existing directories and reports missing paths", () => {
  const root = mkdirTempRoot();
  try {
    const profileDir = join(root, "profile");
    const sessionsDir = join(root, "sessions");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "marker.txt"), "profile", "utf-8");

    const results = clearBrowserDataTargets([
      {
        instanceId: "boss-a",
        kind: "profiles",
        path: profileDir,
        exists: true,
      },
      {
        instanceId: "boss-a",
        kind: "sessions",
        path: sessionsDir,
        exists: false,
      },
    ]);

    assert.equal(results[0]?.status, "deleted");
    assert.equal(results[1]?.status, "missing");
    assert.equal(existsSync(profileDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearBrowserDataTargets refuses files and protected subtrees", () => {
  const root = mkdirTempRoot();
  try {
    const filePath = join(root, "profile-file");
    const protectedDataDir = join(root, "agents");
    const protectedChild = join(protectedDataDir, "browser-profile");
    writeFileSync(filePath, "not a directory", "utf-8");
    mkdirSync(protectedChild, { recursive: true });

    const results = clearBrowserDataTargets(
      [
        {
          instanceId: "boss-a",
          kind: "profiles",
          path: filePath,
          exists: true,
        },
        {
          instanceId: "boss-b",
          kind: "profiles",
          path: protectedChild,
          exists: true,
        },
      ],
      { protectedSubtreeRoots: [protectedDataDir] },
    );

    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.message ?? "", /非目录路径/);
    assert.equal(results[1]?.status, "failed");
    assert.match(results[1]?.message ?? "", /受保护数据目录/);
    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(protectedChild), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertSafeBrowserDataPath rejects protected container paths", () => {
  const browserRoot = resolve(homedir(), ".roll-agent", "browser");

  assert.throws(() => assertSafeBrowserDataPath(homedir()), /危险路径/);
  assert.throws(() => assertSafeBrowserDataPath(resolve("/")), /危险路径/);
  assert.throws(() => assertSafeBrowserDataPath(browserRoot), /危险路径/);
  assert.throws(() => assertSafeBrowserDataPath(join(browserRoot, "profiles")), /危险路径/);
  assert.doesNotThrow(() => assertSafeBrowserDataPath(join(browserRoot, "profiles", "boss-a")));
});

function createBrowserConfig(
  instances: Record<
    string,
    {
      readonly userDataDir: string;
      readonly cdpPort: number;
      readonly sessionsDir?: string;
    }
  >,
): BrowserConfig {
  const browserInstances: BrowserConfig["instances"] = {};
  for (const [id, instance] of Object.entries(instances)) {
    browserInstances[id] = {
      platform: "zhipin",
      mode: "managed-cdp",
      cdpHost: "127.0.0.1",
      cdpPort: instance.cdpPort,
      channel: "chrome",
      userDataDir: instance.userDataDir,
      ...(instance.sessionsDir !== undefined ? { sessionsDir: instance.sessionsDir } : {}),
    };
  }

  return {
    instances: browserInstances,
  };
}

function mkdirTempRoot(): string {
  return resolve(mkdtempSync(join(tmpdir(), "roll-browser-clear-data-")));
}
