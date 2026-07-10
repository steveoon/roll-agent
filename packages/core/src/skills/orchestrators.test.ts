import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ORCHESTRATOR_SKILL_TARGETS,
  detectOrchestratorTargets,
  isOrchestratorTargetId,
} from "./orchestrators.ts";

const fakeHome = mkdtempSync(join(tmpdir(), "roll-orchestrators-test-"));
mkdirSync(join(fakeHome, ".claude"), { recursive: true });
mkdirSync(join(fakeHome, ".agents"), { recursive: true });

after(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("detectOrchestratorTargets", () => {
  it("按 detectDir 存在性判定 present", () => {
    const detected = detectOrchestratorTargets({ home: fakeHome });
    const byId = new Map(detected.map((item) => [item.target.id, item]));

    assert.equal(byId.get("claude-code")?.present, true);
    assert.equal(byId.get("agents")?.present, true);
    assert.equal(byId.get("codex")?.present, false);
  });

  it("用户级目录解析到 home 下", () => {
    const detected = detectOrchestratorTargets({ home: fakeHome });
    const claude = detected.find((item) => item.target.id === "claude-code");
    assert.equal(claude?.skillsDir, join(fakeHome, ".claude/skills"));
  });

  it("--project 模式解析到 cwd 下", () => {
    const fakeCwd = "/fake/project";
    const detected = detectOrchestratorTargets({ home: fakeHome, cwd: fakeCwd, project: true });
    const codex = detected.find((item) => item.target.id === "codex");
    assert.equal(codex?.skillsDir, resolve(fakeCwd, ".codex/skills"));
  });

  it("覆盖全部常量表条目", () => {
    const detected = detectOrchestratorTargets({ home: fakeHome });
    assert.equal(detected.length, ORCHESTRATOR_SKILL_TARGETS.length);
  });
});

describe("isOrchestratorTargetId", () => {
  it("识别合法 id", () => {
    assert.equal(isOrchestratorTargetId("claude-code"), true);
    assert.equal(isOrchestratorTargetId("codex"), true);
    assert.equal(isOrchestratorTargetId("agents"), true);
  });

  it("拒绝未知 id", () => {
    assert.equal(isOrchestratorTargetId("cursor"), false);
    assert.equal(isOrchestratorTargetId(""), false);
  });
});
