import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.ts";
import { loadRuntimeConfig, resolveRuntimeConfigContext } from "./runtime-context.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roll-runtime-context-"));
  const base = join(root, "默认配置");
  const task = join(root, "task");
  mkdirSync(base);
  mkdirSync(task);
  const configPath = join(base, "roll.config.yaml");
  writeFileSync(
    configPath,
    `runtime:\n  threads-dir: ./history\nskills:\n  dirs: [./skills]\nagents:\n  data-dir: ./agents\nscheduler:\n  data-dir: ./ledger\nbrowser:\n  instances:\n    fixture:\n      cdp-port: 54321\n      executable-path: ./bin/chrome\n      user-data-dir: ./profile\n      sessions-dir: ./sessions\nchat:\n  instructions: ./instructions.md\n`,
  );
  writeFileSync(join(task, "roll.config.yaml"), "runtime:\n  threads-dir: ./wrong-history\n");
  return { root, base, task, configPath };
}
test("explicit runtime source anchors resources while preserving task cwd and scheduler semantics", () => {
  const f = fixture();
  try {
    const before = process.cwd();
    const result = loadRuntimeConfig({
      cwd: f.task,
      configPath: f.configPath,
      configWorkspace: f.base,
    });
    assert.equal(result.configPath, f.configPath);
    assert.equal(result.config.runtime.threadsDir, join(f.base, "history"));
    assert.deepEqual(result.config.skills.dirs, [join(f.base, "skills")]);
    assert.equal(result.config.agents.dataDir, join(f.base, "agents"));
    assert.equal(result.config.scheduler.dataDir, join(f.base, "ledger"));
    assert.equal(result.config.chat.instructions, join(f.base, "instructions.md"));
    assert.equal(
      result.config.browser.instances.fixture?.executablePath,
      join(f.base, "bin/chrome"),
    );
    assert.equal(result.config.browser.instances.fixture?.sessionsDir, join(f.base, "sessions"));
    assert.equal(process.cwd(), before);
    assert.deepEqual(loadRuntimeConfig({ cwd: f.task }), loadConfig({ cwd: f.task }));
    assert.equal(resolveRuntimeConfigContext({ cwd: f.task }), undefined);
    assert.equal(
      resolveRuntimeConfigContext({ cwd: f.base, configPath: "roll.config.yaml" })?.configPath,
      f.configPath,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("explicit invalid runtime sources cannot silently fall back", () => {
  const f = fixture();
  try {
    for (const configPath of ["", "   ", join(f.base, "missing.yaml")]) {
      assert.throws(() => loadRuntimeConfig({ cwd: f.task, configPath }));
    }
    assert.throws(() => loadRuntimeConfig({ cwd: f.task, configWorkspace: f.base }), /config/);
    assert.throws(
      () => loadRuntimeConfig({ configPath: f.configPath, configWorkspace: "relative" }),
      /absolute|绝对/,
    );
    assert.throws(
      () =>
        loadRuntimeConfig({ configPath: f.configPath, configWorkspace: join(f.root, "missing") }),
      /directory|目录/,
    );
    assert.throws(
      () => loadRuntimeConfig({ configPath: f.base, configWorkspace: f.base }),
      /regular file/,
    );
    writeFileSync(f.configPath, "chat:\n  instructions: auto\n");
    assert.equal(
      loadRuntimeConfig({ configPath: f.configPath, configWorkspace: f.base }).config.chat
        .instructions,
      "auto",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("resource workspace is independent of config directory and preserves absolute and home paths", () => {
  const f = fixture();
  try {
    const workspace = join(f.root, "resources");
    const absoluteHistory = join(f.root, "absolute-history");
    mkdirSync(workspace);
    writeFileSync(
      f.configPath,
      JSON.stringify({
        agents: { dataDir: "./agents" },
        runtime: { threadsDir: absoluteHistory },
        skills: { dirs: ["~/roll-context-fixture-skills", "./skills"] },
        scheduler: { dataDir: "./ledger" },
        chat: { instructions: "off" },
      }),
    );
    const selected = loadRuntimeConfig({
      cwd: f.task,
      configPath: f.configPath,
      configWorkspace: workspace,
    }).config;
    assert.equal(selected.agents.dataDir, join(workspace, "agents"));
    assert.equal(selected.runtime.threadsDir, absoluteHistory);
    assert.deepEqual(selected.skills.dirs, [
      join(homedir(), "roll-context-fixture-skills"),
      join(workspace, "skills"),
    ]);
    assert.equal(selected.scheduler.dataDir, join(f.base, "ledger"));
    assert.equal(selected.chat.instructions, "off");
    const configOnly = loadRuntimeConfig({
      cwd: f.task,
      configPath: f.configPath,
    }).config;
    assert.equal(configOnly.agents.dataDir, join(f.task, "agents"));
    assert.equal(configOnly.scheduler.dataDir, selected.scheduler.dataDir);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
