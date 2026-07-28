import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_AGENT_CATALOG } from "./catalog.ts";
import { resolveAgentCatalog } from "./catalog-discovery.ts";
import type {
  CatalogCacheFile,
  DiscoveredPackageInfo,
  ResolveCatalogCollaborators,
} from "./catalog-discovery.ts";

const NOW = 1_800_000_000_000;

interface HarnessOptions {
  readonly searchResults?: readonly string[];
  readonly searchError?: boolean;
  readonly packages?: Readonly<Record<string, DiscoveredPackageInfo>>;
  readonly cache?: CatalogCacheFile;
}

function makeCollaborators(options: HarnessOptions): {
  readonly collaborators: ResolveCatalogCollaborators;
  readonly calls: string[];
  readonly written: CatalogCacheFile[];
} {
  const calls: string[] = [];
  const written: CatalogCacheFile[] = [];
  const collaborators: ResolveCatalogCollaborators = {
    searchScopePackages: async () => {
      calls.push("search");
      if (options.searchError) {
        throw new Error("search 不可用");
      }
      return options.searchResults ?? [];
    },
    fetchPackageInfo: async (packageName) => {
      calls.push(`view:${packageName}`);
      return options.packages?.[packageName];
    },
    readCache: () => options.cache,
    writeCache: (cache) => {
      written.push(cache);
    },
    now: () => NOW,
  };
  return { collaborators, calls, written };
}

describe("resolveAgentCatalog", () => {
  it("propagates cancellation instead of converting it into an empty discovery result", async () => {
    const controller = new AbortController();
    const abortReason = new Error("catalog canceled");
    const searchStarted = Promise.withResolvers<void>();
    const { collaborators } = makeCollaborators({});
    const resolving = resolveAgentCatalog(undefined, {
      signal: controller.signal,
      collaborators: {
        ...collaborators,
        searchScopePackages: async (options) => {
          assert.equal(options.signal, controller.signal);
          searchStarted.resolve();
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      },
    });
    await searchStarted.promise;
    controller.abort(abortReason);

    await assert.rejects(resolving, (error: unknown) => error === abortReason);
  });

  it("does not start another package lookup when cancellation races a successful lookup", async () => {
    const controller = new AbortController();
    const abortReason = new Error("stop catalog candidates");
    const fetchCalls: string[] = [];
    const { collaborators } = makeCollaborators({
      searchResults: ["@roll-agent/a-agent", "@roll-agent/b-agent"],
    });

    await assert.rejects(
      resolveAgentCatalog(undefined, {
        signal: controller.signal,
        collaborators: {
          ...collaborators,
          fetchPackageInfo: async (packageName) => {
            fetchCalls.push(packageName);
            controller.abort(abortReason);
            return { description: packageName, hasRollAgentManifest: true };
          },
        },
      }),
      (error: unknown) => error === abortReason,
    );
    assert.deepEqual(fetchCalls, ["@roll-agent/a-agent"]);
  });

  it("发现带 rollAgent manifest 的新包并合并在内置之后", async () => {
    const { collaborators, written } = makeCollaborators({
      searchResults: ["@roll-agent/new-thing-agent", "@roll-agent/sdk", "unrelated-package"],
      packages: {
        "@roll-agent/new-thing-agent": {
          description: "新工具 Agent",
          hasRollAgentManifest: true,
        },
        "@roll-agent/sdk": { description: "SDK", hasRollAgentManifest: false },
      },
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    const discovered = catalog.find((entry) => entry.packageName === "@roll-agent/new-thing-agent");
    assert.equal(discovered?.shortName, "new-thing");
    assert.equal(discovered?.skillName, "new-thing-agent");
    assert.equal(discovered?.description, "新工具 Agent");
    assert.deepEqual(discovered?.requiredEnv, []);
    assert.equal(catalog.length, OFFICIAL_AGENT_CATALOG.length + 1);
    assert.ok(!catalog.some((entry) => entry.packageName === "@roll-agent/sdk"));
    assert.equal(written.length, 1);
    assert.equal(written[0]?.checkedAt, NOW);
    assert.equal(written[0]?.entries.length, 1);
  });

  it("内置包不重复 view，且内置元数据优先", async () => {
    const builtInPackage = OFFICIAL_AGENT_CATALOG[0].packageName;
    const { collaborators, calls } = makeCollaborators({
      searchResults: [builtInPackage],
      packages: {},
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    assert.ok(!calls.includes(`view:${builtInPackage}`));
    assert.equal(catalog.length, OFFICIAL_AGENT_CATALOG.length);
  });

  it("shortName 冲突时回退为去 scope 的完整名，回退仍冲突则跳过", async () => {
    const { collaborators } = makeCollaborators({
      searchResults: ["@roll-agent/foo", "@roll-agent/foo-agent", "@roll-agent/octopus"],
      packages: {
        "@roll-agent/foo": { description: "占用 foo 短名", hasRollAgentManifest: true },
        "@roll-agent/foo-agent": { description: "派生名冲突后回退", hasRollAgentManifest: true },
        "@roll-agent/octopus": {
          description: "与内置 octopus 短名冲突且无可用回退",
          hasRollAgentManifest: true,
        },
      },
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    assert.equal(catalog.find((e) => e.packageName === "@roll-agent/foo")?.shortName, "foo");
    assert.equal(
      catalog.find((e) => e.packageName === "@roll-agent/foo-agent")?.shortName,
      "foo-agent",
    );
    assert.ok(!catalog.some((e) => e.packageName === "@roll-agent/octopus"));
  });

  it("缓存 TTL 内直接使用缓存，不触发 search", async () => {
    const cachedEntry = {
      shortName: "cached",
      packageName: "@roll-agent/cached-agent",
      skillName: "cached-agent",
      description: "缓存条目",
      requiredEnv: [],
    };
    const { collaborators, calls } = makeCollaborators({
      cache: { checkedAt: NOW - 1000, registry: "", entries: [cachedEntry] },
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    assert.equal(calls.length, 0);
    assert.ok(catalog.some((entry) => entry.packageName === "@roll-agent/cached-agent"));
  });

  it("缓存 registry 与当前不一致时视为 miss，重新发现并按当前 registry 写回", async () => {
    const internalEntry = {
      shortName: "internal",
      packageName: "@roll-agent/internal-agent",
      skillName: "internal-agent",
      description: "私有 registry 条目",
      requiredEnv: [],
    };
    const { collaborators, calls, written } = makeCollaborators({
      cache: {
        checkedAt: NOW - 1000,
        registry: "https://npm.internal.example.com",
        entries: [internalEntry],
      },
      searchResults: [],
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    assert.ok(calls.includes("search"));
    assert.ok(!catalog.some((entry) => entry.packageName === "@roll-agent/internal-agent"));
    assert.equal(written[0]?.registry, "");
  });

  it("allowNetwork=false 且缓存 registry 不一致时不展示缓存条目", async () => {
    const internalEntry = {
      shortName: "internal",
      packageName: "@roll-agent/internal-agent",
      skillName: "internal-agent",
      description: "私有 registry 条目",
      requiredEnv: [],
    };
    const { collaborators, calls } = makeCollaborators({
      cache: {
        checkedAt: NOW - 1000,
        registry: "https://npm.internal.example.com",
        entries: [internalEntry],
      },
    });

    const catalog = await resolveAgentCatalog(undefined, {
      allowNetwork: false,
      collaborators,
    });

    assert.equal(calls.length, 0);
    assert.ok(!catalog.some((entry) => entry.packageName === "@roll-agent/internal-agent"));
  });

  it("发现结果写入缓存时记录当前 registry", async () => {
    const { collaborators, written } = makeCollaborators({ searchResults: [] });

    await resolveAgentCatalog(undefined, {
      registry: "https://npm.internal.example.com",
      collaborators,
    });

    assert.equal(written[0]?.registry, "https://npm.internal.example.com");
  });

  it("forceRefresh 绕过有效缓存重新联网", async () => {
    const { collaborators, calls } = makeCollaborators({
      cache: { checkedAt: NOW - 1000, registry: "", entries: [] },
      searchResults: [],
    });

    await resolveAgentCatalog(undefined, { forceRefresh: true, collaborators });

    assert.ok(calls.includes("search"));
  });

  it("allowNetwork=false 时只用缓存与内置", async () => {
    const staleEntry = {
      shortName: "stale",
      packageName: "@roll-agent/stale-agent",
      skillName: "stale-agent",
      description: "过期缓存条目",
      requiredEnv: [],
    };
    const { collaborators, calls } = makeCollaborators({
      cache: { checkedAt: NOW - CACHE_STALE_MS, registry: "", entries: [staleEntry] },
    });

    const catalog = await resolveAgentCatalog(undefined, {
      allowNetwork: false,
      collaborators,
    });

    assert.equal(calls.length, 0);
    assert.ok(catalog.some((entry) => entry.packageName === "@roll-agent/stale-agent"));
  });

  it("search 失败时降级为过期缓存 + 内置", async () => {
    const staleEntry = {
      shortName: "stale",
      packageName: "@roll-agent/stale-agent",
      skillName: "stale-agent",
      description: "过期缓存条目",
      requiredEnv: [],
    };
    const { collaborators, written } = makeCollaborators({
      searchError: true,
      cache: { checkedAt: NOW - CACHE_STALE_MS, registry: "", entries: [staleEntry] },
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    assert.ok(catalog.some((entry) => entry.packageName === "@roll-agent/stale-agent"));
    assert.equal(written.length, 0);
  });

  it("单个包 view 失败跳过，不影响其余发现", async () => {
    const { collaborators } = makeCollaborators({
      searchResults: ["@roll-agent/good-agent", "@roll-agent/broken-agent"],
      packages: {
        "@roll-agent/good-agent": { description: "正常", hasRollAgentManifest: true },
      },
    });
    const withThrowingView: ResolveCatalogCollaborators = {
      ...collaborators,
      fetchPackageInfo: async (packageName) => {
        if (packageName === "@roll-agent/broken-agent") {
          throw new Error("view 超时");
        }
        return { description: "正常", hasRollAgentManifest: true };
      },
    };

    const catalog = await resolveAgentCatalog(undefined, { collaborators: withThrowingView });

    assert.ok(catalog.some((entry) => entry.packageName === "@roll-agent/good-agent"));
    assert.ok(!catalog.some((entry) => entry.packageName === "@roll-agent/broken-agent"));
  });

  it("缺 description 时回退为包名", async () => {
    const { collaborators } = makeCollaborators({
      searchResults: ["@roll-agent/no-desc-agent"],
      packages: {
        "@roll-agent/no-desc-agent": { hasRollAgentManifest: true },
      },
    });

    const catalog = await resolveAgentCatalog(undefined, { collaborators });

    const entry = catalog.find((item) => item.packageName === "@roll-agent/no-desc-agent");
    assert.equal(entry?.description, "@roll-agent/no-desc-agent");
  });
});

const CACHE_STALE_MS = 25 * 60 * 60 * 1000;
