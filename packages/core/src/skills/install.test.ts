import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstallableSkills, findExistingSkillInstalls, installSkillsToDir } from "./install.ts";

const workDir = mkdtempSync(join(tmpdir(), "roll-skill-install-test-"));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeSkill(dir: string, frontmatter: string, body = "# Body\n"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

describe("collectInstallableSkills", () => {
  it("目录直含 SKILL.md 时识别为单 skill", () => {
    const dir = join(workDir, "single-skill");
    writeSkill(dir, "name: my-skill\ndescription: 一个测试 skill");

    const result = collectInstallableSkills(dir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.name, "my-skill");
    assert.equal(result.skills[0]?.sourceDir, dir);
    assert.deepEqual(result.issues, []);
  });

  it("多 skill 子目录集合逐个收集，无效项进 issues", () => {
    const root = join(workDir, "collection");
    writeSkill(join(root, "alpha"), "name: alpha-skill\ndescription: alpha");
    writeSkill(join(root, "broken"), "description: 缺 name");
    writeSkill(join(root, "beta"), "name: beta-skill\ndescription: beta");
    mkdirSync(join(root, "not-a-skill"), { recursive: true });

    const result = collectInstallableSkills(root);
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["alpha-skill", "beta-skill"],
    );
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0] ?? "", /缺少有效的 frontmatter name/);
  });

  it("缺 description 记入 issues", () => {
    const dir = join(workDir, "no-description");
    writeSkill(dir, "name: no-desc");

    const result = collectInstallableSkills(dir);
    assert.equal(result.skills.length, 0);
    assert.match(result.issues[0] ?? "", /缺少有效的 frontmatter description/);
  });

  it("目录不存在或无任何 skill 时给出 issue", () => {
    const missing = collectInstallableSkills(join(workDir, "does-not-exist"));
    assert.equal(missing.skills.length, 0);
    assert.match(missing.issues[0] ?? "", /目录不存在/);

    const emptyDir = join(workDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const empty = collectInstallableSkills(emptyDir);
    assert.equal(empty.skills.length, 0);
    assert.match(empty.issues[0] ?? "", /未在 .* 找到包含 SKILL.md 的 skill 目录/);
  });
});

describe("installSkillsToDir", () => {
  it("全新安装复制整个 skill 目录（含 references/）", () => {
    const sourceDir = join(workDir, "src-with-refs");
    writeSkill(sourceDir, "name: ref-skill\ndescription: 带 references");
    mkdirSync(join(sourceDir, "references"), { recursive: true });
    writeFileSync(join(sourceDir, "references", "guide.md"), "# guide\n", "utf-8");

    const targetDir = join(workDir, "target-fresh");
    const { skills } = collectInstallableSkills(sourceDir);
    const records = installSkillsToDir(skills, targetDir);

    assert.equal(records.length, 1);
    assert.equal(records[0]?.overwritten, false);
    assert.equal(records[0]?.targetPath, join(targetDir, "ref-skill"));
    assert.ok(existsSync(join(targetDir, "ref-skill", "SKILL.md")));
    assert.ok(existsSync(join(targetDir, "ref-skill", "references", "guide.md")));
  });

  it("覆盖更新清掉目标目录残留文件", () => {
    const sourceDir = join(workDir, "src-v2");
    writeSkill(sourceDir, "name: evolving-skill\ndescription: v2");

    const targetDir = join(workDir, "target-overwrite");
    const stalePath = join(targetDir, "evolving-skill");
    mkdirSync(stalePath, { recursive: true });
    writeFileSync(join(stalePath, "SKILL.md"), "old content", "utf-8");
    writeFileSync(join(stalePath, "stale-file.md"), "should be removed", "utf-8");

    const { skills } = collectInstallableSkills(sourceDir);
    const records = installSkillsToDir(skills, targetDir);

    assert.equal(records[0]?.overwritten, true);
    assert.ok(!existsSync(join(stalePath, "stale-file.md")));
    assert.match(readFileSync(join(stalePath, "SKILL.md"), "utf-8"), /v2/);
  });
});

describe("findExistingSkillInstalls", () => {
  it("按 sanitize 后的目录名检测已安装项", () => {
    const sourceDir = join(workDir, "src-exists-check");
    writeSkill(sourceDir, "name: Exists-Check\ndescription: 大小写混合名");

    const targetDir = join(workDir, "target-exists-check");
    mkdirSync(join(targetDir, "exists-check"), { recursive: true });

    const { skills } = collectInstallableSkills(sourceDir);
    assert.deepEqual(findExistingSkillInstalls(skills, targetDir), ["Exists-Check"]);
    assert.deepEqual(findExistingSkillInstalls(skills, join(workDir, "nowhere")), []);
  });
});
