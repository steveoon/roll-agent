import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  OFFICIAL_AGENT_CATALOG,
  catalogPackageSpec,
  findCatalogEntry,
  getAgentCatalog,
} from "./catalog.ts";
import { discoverAgent } from "./discovery.ts";

describe("findCatalogEntry", () => {
  it("短名命中官方条目", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "browser-use");
    assert.equal(match?.entry.packageName, "@roll-agent/browser-use-agent");
    assert.equal(match?.versionSpec, undefined);
  });

  it("短名带版本时保留版本", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "browser-use@0.21.1");
    assert.equal(match?.entry.shortName, "browser-use");
    assert.equal(match?.versionSpec, "0.21.1");
  });

  it("完整包名命中", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "@roll-agent/smart-reply-agent");
    assert.equal(match?.entry.shortName, "smart-reply");
    assert.equal(match?.versionSpec, undefined);
  });

  it("skillName 命中官方条目", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "octopus-agent");
    assert.equal(match?.entry.packageName, "@roll-agent/octopus-agent");
    assert.equal(match?.versionSpec, undefined);
  });

  it("scoped 包名带版本范围时保留版本", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "@roll-agent/smart-reply-agent@^1.3.0");
    assert.equal(match?.entry.shortName, "smart-reply");
    assert.equal(match?.versionSpec, "^1.3.0");
  });

  it("skillName 带版本时保留版本", () => {
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "octopus-agent@0.1.2");
    assert.equal(match?.entry.packageName, "@roll-agent/octopus-agent");
    assert.equal(match?.versionSpec, "0.1.2");
  });

  it("非 catalog 包名不命中", () => {
    assert.equal(findCatalogEntry(OFFICIAL_AGENT_CATALOG, "some-other-package"), undefined);
    assert.equal(findCatalogEntry(OFFICIAL_AGENT_CATALOG, "@other-scope/browser-use-agent"), undefined);
  });

  it("空输入与空版本号安全处理", () => {
    assert.equal(findCatalogEntry(OFFICIAL_AGENT_CATALOG, ""), undefined);
    assert.equal(findCatalogEntry(OFFICIAL_AGENT_CATALOG, "   "), undefined);
    const match = findCatalogEntry(OFFICIAL_AGENT_CATALOG, "smart-reply@");
    assert.equal(match?.entry.shortName, "smart-reply");
    assert.equal(match?.versionSpec, undefined);
  });
});

describe("catalogPackageSpec", () => {
  it("无版本时返回包名", () => {
    const entry = OFFICIAL_AGENT_CATALOG[0];
    assert.equal(catalogPackageSpec(entry), entry.packageName);
  });

  it("带版本时拼接 spec", () => {
    const entry = OFFICIAL_AGENT_CATALOG[0];
    assert.equal(catalogPackageSpec(entry, "0.21.1"), `${entry.packageName}@0.21.1`);
  });
});

describe("OFFICIAL_AGENT_CATALOG 自检", () => {
  it("shortName 与 packageName 唯一", () => {
    const shortNames = OFFICIAL_AGENT_CATALOG.map((entry) => entry.shortName);
    const packageNames = OFFICIAL_AGENT_CATALOG.map((entry) => entry.packageName);
    assert.equal(new Set(shortNames).size, shortNames.length);
    assert.equal(new Set(packageNames).size, packageNames.length);
  });

  it("shortName 使用 kebab-case", () => {
    for (const entry of OFFICIAL_AGENT_CATALOG) {
      assert.match(entry.shortName, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("requiredEnv 非空且不重复", () => {
    for (const entry of OFFICIAL_AGENT_CATALOG) {
      assert.ok(entry.requiredEnv.length > 0);
      assert.equal(new Set(entry.requiredEnv).size, entry.requiredEnv.length);
    }
  });

  it("getAgentCatalog 默认返回官方 catalog", () => {
    assert.equal(getAgentCatalog(), OFFICIAL_AGENT_CATALOG);
  });
});

describe("OFFICIAL_AGENT_CATALOG 与 SKILL.md env 声明一致性", () => {
  const agentsDir = resolve(import.meta.dirname, "../../../../agents");
  const agentDirs = existsSync(agentsDir)
    ? readdirSync(agentsDir, { withFileTypes: true }).filter((item) => item.isDirectory())
    : [];

  it(
    "monorepo 内官方 Agent 的 requiredEnv 与 SKILL.md 声明一致",
    { skip: agentDirs.length === 0 },
    () => {
      const catalogBySkillName = new Map<string, (typeof OFFICIAL_AGENT_CATALOG)[number]>(
        OFFICIAL_AGENT_CATALOG.map((entry) => [entry.skillName, entry]),
      );
      let checked = 0;
      for (const dir of agentDirs) {
        const discovered = discoverAgent(resolve(agentsDir, dir.name));
        const entry = catalogBySkillName.get(discovered.skill.name);
        if (!entry) {
          continue;
        }
        const declared = (discovered.skill.env?.required ?? []).map((item) => item.name);
        assert.deepEqual(
          [...entry.requiredEnv].sort(),
          declared.sort(),
          `catalog requiredEnv 与 ${discovered.skill.name} 的 SKILL.md env 声明漂移`,
        );
        checked += 1;
      }
      assert.ok(checked > 0);
    },
  );
});
