import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildConfigYaml, runRoll } from "./smoke.e2e-harness.ts";

function setupWorkspace(): { readonly workspace: string; readonly env: Record<string, string> } {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-schedule-${randomUUID()}-`));
  const dataDir = resolve(workspace, "agents");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(workspace, "roll.config.yaml"),
    `${buildConfigYaml(dataDir)}
scheduler:
  data-dir: ${resolve(workspace, "scheduler")}
`,
  );
  return { workspace, env: { HOME: workspace } };
}

test("e2e smoke: roll schedule add/list/pause/resume/remove --json", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const added = runRoll(
      [
        "schedule",
        "add",
        "检查未读并汇总",
        "--name",
        "巡检",
        "--every",
        "30m",
        "--cwd",
        workspace,
        "--json",
      ],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string; status: string; nextRunAt: string };
    assert.equal(created.status, "active");
    assert.ok(Date.parse(created.nextRunAt) > Date.now() + 29 * 60_000);

    const listed = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; trigger: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
    assert.equal(rows[0]?.trigger, "每 30 分钟");

    assert.equal(runRoll(["schedule", "pause", created.id], workspace, { env }).status, 0);
    const shown = runRoll(["schedule", "show", created.id, "--json"], workspace, { env });
    assert.equal((JSON.parse(shown.stdout) as { status: string }).status, "paused");
    assert.equal(runRoll(["schedule", "resume", created.id], workspace, { env }).status, 0);

    const runs = runRoll(["schedule", "runs", created.id, "--json"], workspace, { env });
    assert.equal(runs.status, 0, runs.stderr);
    assert.deepEqual(JSON.parse(runs.stdout), []);

    assert.equal(runRoll(["schedule", "remove", created.id], workspace, { env }).status, 0);
    const empty = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll schedule add 拒绝低于 60 秒的间隔与不存在的 cwd", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const tooFast = runRoll(
      ["schedule", "add", "x", "--name", "快", "--every", "30s", "--cwd", workspace],
      workspace,
      { env },
    );
    assert.equal(tooFast.status, 1);
    assert.match(tooFast.stderr, /60/u);
    const missingCwd = runRoll(
      [
        "schedule",
        "add",
        "x",
        "--name",
        "无目录",
        "--every",
        "5m",
        "--cwd",
        resolve(workspace, "nope"),
      ],
      workspace,
      { env },
    );
    assert.equal(missingCwd.status, 1);
    assert.match(missingCwd.stderr, /cwd/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll --help 列出 schedule", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const result = runRoll(["--help"], workspace, { env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\bschedule\b/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
