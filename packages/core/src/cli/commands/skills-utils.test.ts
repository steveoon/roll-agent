import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RegisteredAgent } from "../../types/agent.ts";
import {
  getAgentSkillPath,
  listAgentSkills,
  resolveAgentSkillDocument,
  resolveAgentSkillPath,
} from "./skills-utils.ts";

describe("skills utils", () => {
  it("should read SKILL.md from the agent install path when available", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    const skillPath = join(installPath, "SKILL.md");
    writeFileSync(skillPath, "---\nname: demo-agent\n---\n\nCurrent skill body\n", "utf-8");
    const agent = createRegisteredAgent({ installPath });

    const document = resolveAgentSkillDocument(agent);

    assert.equal(getAgentSkillPath(agent), skillPath);
    assert.equal(resolveAgentSkillPath(agent), skillPath);
    assert.equal(document.source, "filesystem");
    assert.equal(document.path, skillPath);
    assert.match(document.content, /Current skill body/);
  });

  it("should fall back to the registry snapshot when SKILL.md is unavailable", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    const agent = createRegisteredAgent({
      installPath,
      skillBody: "Stored skill body",
    });

    const document = resolveAgentSkillDocument(agent);

    assert.equal(resolveAgentSkillPath(agent), undefined);
    assert.equal(document.source, "registry");
    assert.equal(document.path, undefined);
    assert.match(document.content, /name: "demo-agent"/);
    assert.match(document.content, /Stored skill body/);
  });

  it("should include referenced local documents on demand", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    mkdirSync(join(installPath, "references"), { recursive: true });
    writeFileSync(
      join(installPath, "SKILL.md"),
      [
        "---",
        "name: demo-agent",
        "metadata:",
        "  roll-env-file: references/env.yaml",
        "---",
        "",
        "Read [workflow](./references/workflows.md) and `references/env.yaml`.",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(installPath, "references", "workflows.md"), "# Workflow\n", "utf-8");
    writeFileSync(join(installPath, "references", "env.yaml"), "env:\n", "utf-8");

    const document = resolveAgentSkillDocument(createRegisteredAgent({ installPath }), {
      includeReferences: true,
    });

    assert.deepEqual(
      document.references?.map((reference) => reference.relativePath),
      ["references/env.yaml", "references/workflows.md"],
    );
    assert.match(document.references?.[0]?.content ?? "", /env:/);
    assert.match(document.references?.[1]?.content ?? "", /# Workflow/);
  });

  it("should skip referenced files that escape the agent directory", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    const externalPath = join(mkdtempSync(join(tmpdir(), "roll-skill-external-")), "secret.md");
    mkdirSync(join(installPath, "references"), { recursive: true });
    writeFileSync(externalPath, "secret", "utf-8");
    symlinkSync(externalPath, join(installPath, "references", "secret.md"));
    writeFileSync(
      join(installPath, "SKILL.md"),
      "See `references/secret.md` and `references/missing.md`.",
      "utf-8",
    );

    const document = resolveAgentSkillDocument(createRegisteredAgent({ installPath }), {
      includeReferences: true,
    });

    assert.deepEqual(document.references, []);
  });

  it("should expose an empty references array for registry snapshots", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    const agent = createRegisteredAgent({
      installPath,
      skillBody: "See `references/workflows.md`.",
    });

    const document = resolveAgentSkillDocument(agent, { includeReferences: true });

    assert.equal(document.source, "registry");
    assert.deepEqual(document.references, []);
  });

  it("should list skill sources without reading fallback content", () => {
    const installPath = mkdtempSync(join(tmpdir(), "roll-skill-"));
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, "SKILL.md"), "Skill content", "utf-8");
    const skills = listAgentSkills([createRegisteredAgent({ installPath })]);

    assert.deepEqual(skills, [
      {
        name: "demo-agent",
        description: "Demo agent",
        source: "filesystem",
        path: join(installPath, "SKILL.md"),
      },
    ]);
  });
});

function createRegisteredAgent(overrides: {
  readonly installPath: string;
  readonly skillBody?: string;
}): RegisteredAgent {
  return {
    skill: {
      name: "demo-agent",
      description: "Demo agent",
      metadata: {},
    },
    transport: { type: "stdio", command: "node", args: ["index.js"] },
    runtime: { ownership: "on-demand" },
    installPath: overrides.installPath,
    registeredAt: new Date().toISOString(),
    status: "idle",
    ...(overrides.skillBody ? { skillBody: overrides.skillBody } : {}),
  };
}
