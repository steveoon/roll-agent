import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectCatalogAvailability } from "./catalog-status.ts";
import type { AgentCatalogEntry } from "../../registry/catalog.ts";
import type { PublishedPackageUpdateInfo } from "./update-checker.ts";
import type { RegisteredAgent } from "../../types/agent.ts";

const CATALOG: readonly AgentCatalogEntry[] = [
  {
    shortName: "browser-use",
    packageName: "@roll-agent/browser-use-agent",
    skillName: "browser-use-agent",
    description: "浏览器操控 Agent",
    requiredEnv: ["REPLY_AUTHORITY_URL"],
  },
  {
    shortName: "smart-reply",
    packageName: "@roll-agent/smart-reply-agent",
    skillName: "smart-reply-agent",
    description: "智能回复 Agent",
    requiredEnv: ["REPLY_AUTHORITY_URL"],
  },
];

function makeAgent(overrides: Partial<RegisteredAgent> & { name: string }): RegisteredAgent {
  const { name, ...rest } = overrides;
  return {
    skill: { name, description: "test agent", metadata: {} },
    transport: { type: "stdio", command: "node" },
    runtime: { ownership: "on-demand" },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
    ...rest,
  };
}

function fakeUpdate(info: Partial<PublishedPackageUpdateInfo>): typeof import("./update-checker.ts").checkPublishedPackageUpdate {
  return async (input) => ({
    packageName: input.packageName,
    ...(input.currentVersion ? { currentVersion: input.currentVersion } : {}),
    status: "up-to-date",
    ...info,
  });
}

describe("inspectCatalogAvailability", () => {
  it("installed-package 来源命中为 installed 并透传 update", async () => {
    const agents = [
      makeAgent({
        name: "browser-use-agent",
        source: {
          type: "installed-package",
          packageName: "@roll-agent/browser-use-agent",
          packageSpec: "@roll-agent/browser-use-agent",
          installDir: "/tmp/installed/browser-use",
          installedVersion: "0.20.0",
        },
      }),
    ];
    const items = await inspectCatalogAvailability(CATALOG, agents, {
      fetchLatest: async () => "9.9.9",
      checkUpdate: fakeUpdate({ latestVersion: "0.21.1", status: "update-available" }),
    });

    const browserUse = items.find((item) => item.entry.shortName === "browser-use");
    assert.equal(browserUse?.state, "installed");
    assert.equal(browserUse?.installedAgent?.skill.name, "browser-use-agent");
    assert.equal(browserUse?.latestVersion, "0.21.1");
    assert.equal(browserUse?.update?.status, "update-available");

    const smartReply = items.find((item) => item.entry.shortName === "smart-reply");
    assert.equal(smartReply?.state, "not-installed");
    assert.equal(smartReply?.latestVersion, "9.9.9");
    assert.equal(smartReply?.update, undefined);
  });

  it("skillName 命中其他来源时标记 installed-other-source", async () => {
    const agents = [
      makeAgent({
        name: "smart-reply-agent",
        source: { type: "local-path", path: "/repo/agents/smart-reply" },
      }),
    ];
    const items = await inspectCatalogAvailability(CATALOG, agents, {
      fetchLatest: async () => "1.3.4",
      checkUpdate: fakeUpdate({}),
    });

    const smartReply = items.find((item) => item.entry.shortName === "smart-reply");
    assert.equal(smartReply?.state, "installed-other-source");
    assert.equal(smartReply?.installedAgent?.source?.type, "local-path");
    assert.equal(smartReply?.latestVersion, "1.3.4");
  });

  it("网络失败时降级为 latest 未知", async () => {
    const items = await inspectCatalogAvailability(CATALOG, [], {
      fetchLatest: async () => undefined,
      checkUpdate: fakeUpdate({}),
    });

    for (const item of items) {
      assert.equal(item.state, "not-installed");
      assert.equal(item.latestVersion, undefined);
    }
  });

  it("透传 allowNetwork 与 registry 查询选项", async () => {
    const seenOptions: unknown[] = [];
    await inspectCatalogAvailability(CATALOG, [], {
      allowNetwork: false,
      registry: "https://registry.example.com",
      fetchLatest: async (_pkg, options) => {
        seenOptions.push(options);
        return undefined;
      },
      checkUpdate: fakeUpdate({}),
    });

    assert.equal(seenOptions.length, 2);
    assert.deepEqual(seenOptions[0], {
      allowNetwork: false,
      registry: "https://registry.example.com",
    });
  });
});
