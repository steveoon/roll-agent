import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredAgent } from "../types/agent.ts";
import { createSkillLibrary, findProjectSkillsDir } from "./library.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-skills-"));
}

function writeSkill(dir: string, name: string, frontmatter: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");
  return skillDir;
}

function makeAgent(overrides: Partial<RegisteredAgent> & { installPath: string }): RegisteredAgent {
  return {
    skill: { name: "demo-agent", description: "demo agent skill", metadata: {} },
    transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
    runtime: { ownership: "on-demand" },
    registeredAt: "2026-07-06T00:00:00.000Z",
    status: "idle",
    ...overrides,
  };
}

test("createSkillLibrary 发现 canonical 目录中的 skill 并读取 frontmatter", () => {
  const home = tempDir();
  const project = tempDir();
  try {
    const skillsDir = join(project, ".agents", "skills");
    writeSkill(skillsDir, "web-design", "name: web-design\ndescription: 网页设计指南", "设计正文");
    writeSkill(skillsDir, "no-frontmatter-name", "description: 缺 name 用目录名", "正文");

    const nestedCwd = join(project, "src", "deep");
    mkdirSync(nestedCwd, { recursive: true });
    const library = createSkillLibrary({ cwd: nestedCwd, home });

    const names = library.list().map((skill) => skill.name);
    assert.deepEqual(names.sort(), ["no-frontmatter-name", "web-design"]);
    const summary = library.list().find((skill) => skill.name === "web-design");
    assert.equal(summary?.description, "网页设计指南");
    assert.equal(summary?.source, "project");

    const loaded = library.load("web-design");
    assert.ok(loaded?.content.includes("设计正文"));
    assert.equal(loaded?.skillRoot, realpathSync(join(skillsDir, "web-design")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("findProjectSkillsDir 从嵌套目录向上查找", () => {
  const project = tempDir();
  try {
    const skillsDir = join(project, ".agents", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const nested = join(project, "a", "b");
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectSkillsDir(nested), skillsDir);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("重名时按 agent > project > user 优先级保留", () => {
  const home = tempDir();
  const project = tempDir();
  try {
    writeSkill(join(home, ".agents", "skills"), "dup", "name: dup\ndescription: user 版", "user");
    writeSkill(
      join(project, ".agents", "skills"),
      "dup",
      "name: dup\ndescription: project 版",
      "project",
    );
    const issues: string[] = [];
    const library = createSkillLibrary({
      cwd: project,
      home,
      onIssue: (message) => issues.push(message),
    });

    assert.equal(library.list().length, 1);
    assert.equal(library.list()[0]?.description, "project 版");
    assert.equal(issues.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("extraDirs 支持目录即 skill 与 skill 集合目录两种布局", () => {
  const home = tempDir();
  const cwd = tempDir();
  const single = tempDir();
  const collection = tempDir();
  try {
    writeFileSync(
      join(single, "SKILL.md"),
      "---\nname: single-skill\ndescription: 单目录\n---\n\n正文引用 references/guide.md\n",
      "utf-8",
    );
    mkdirSync(join(single, "references"), { recursive: true });
    writeFileSync(join(single, "references", "guide.md"), "指南内容", "utf-8");
    writeSkill(collection, "col-a", "name: col-a\ndescription: 集合A", "A");

    const library = createSkillLibrary({ cwd, home, extraDirs: [single, collection] });
    const names = library.list().map((skill) => skill.name);
    assert.deepEqual(names.sort(), ["col-a", "single-skill"]);

    const loaded = library.load("single-skill");
    assert.deepEqual(loaded?.referencePaths, ["references/guide.md"]);
    assert.equal(loaded?.skillRoot, realpathSync(single));
    assert.equal(library.loadReference("single-skill", "references/guide.md"), "指南内容");
    const reference = library.loadReferenceDocument?.("single-skill", "references/guide.md");
    assert.equal(reference?.content, "指南内容");
    assert.equal(reference?.skillRoot, realpathSync(single));
    assert.equal(library.loadReference("single-skill", "references/../SKILL.md"), undefined);
    assert.equal(library.loadReference("single-skill", "../outside.md"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(single, { recursive: true, force: true });
    rmSync(collection, { recursive: true, force: true });
  }
});

test("agent skill 优先使用 installPath 的 SKILL.md，缺失时回退 skillBody", () => {
  const home = tempDir();
  const cwd = tempDir();
  const installA = tempDir();
  const installB = tempDir();
  try {
    writeFileSync(
      join(installA, "SKILL.md"),
      "---\nname: agent-a\ndescription: A\n---\n\n文件版正文\n",
      "utf-8",
    );
    const agentA = makeAgent({
      installPath: installA,
      skill: { name: "agent-a", description: "A", metadata: {} },
    });
    const agentB = makeAgent({
      installPath: join(installB, "missing"),
      skill: { name: "agent-b", description: "B", metadata: {} },
      skillBody: "注册表正文",
    });

    const library = createSkillLibrary({ cwd, home, agents: [agentA, agentB] });
    assert.equal(library.load("agent-a")?.content.includes("文件版正文"), true);
    assert.equal(library.load("agent-b")?.content, "注册表正文");
    assert.equal(
      library.list().every((skill) => skill.source === "agent"),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(installA, { recursive: true, force: true });
    rmSync(installB, { recursive: true, force: true });
  }
});

test("frontmatter 解析失败时跳过并上报 issue，未知 skill 返回 undefined", () => {
  const home = tempDir();
  const cwd = tempDir();
  const dir = tempDir();
  try {
    const broken = join(dir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "SKILL.md"), "---\nname: [broken\n---\n\n正文\n", "utf-8");

    const issues: string[] = [];
    const library = createSkillLibrary({
      cwd,
      home,
      extraDirs: [dir],
      onIssue: (message) => issues.push(message),
    });
    assert.equal(library.list().length, 0);
    assert.equal(issues.length, 1);
    assert.equal(library.load("nonexistent"), undefined);
    assert.equal(library.loadReference("nonexistent", "references/a.md"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
