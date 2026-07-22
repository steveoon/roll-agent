import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import type { RegisteredAgent } from "../types/agent.ts";
import { buildRollConfigCatalog, type ConfigCatalogNode } from "./catalog.ts";
import { findConfigGuidance, listConfigGuidanceEntries } from "./guidance.ts";

function findNode(root: ConfigCatalogNode, path: readonly string[]): ConfigCatalogNode {
  let current = root;
  for (const segment of path) {
    if (current.kind === "object") {
      const child = current.fields[segment];
      assert.ok(child, `missing catalog node ${path.join(".")}`);
      current = child;
      continue;
    }
    if (current.kind === "record" && segment === "*") {
      current = current.value;
      continue;
    }
    if (current.kind === "array" && segment === "*") {
      current = current.item;
      continue;
    }
    assert.fail(`cannot traverse ${segment} through ${current.kind}`);
  }
  return current;
}

function makeAgent(): RegisteredAgent {
  return {
    skill: {
      name: "browser-use-agent",
      description: "Browser automation",
      metadata: {},
      env: {
        required: [
          { name: "REPLY_AUTHORITY_TOKEN", purpose: "Authenticate replies" },
          { name: "BROWSER_INSTANCES_JSON", purpose: "Derived browser declarations" },
        ],
        optional: [
          {
            name: "REPLY_AUTHORITY_URL",
            example: "https://example.test",
            secret: false,
          },
          { name: "ENABLE_TRACE", default: "false", secret: false },
        ],
      },
    },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3100/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 3100 },
    },
    installPath: "/tmp/browser-use-agent",
    registeredAt: "2026-07-14T00:00:00.000Z",
    status: "idle",
  };
}

describe("buildRollConfigCatalog", () => {
  it("provides complete human guidance for every Roll config leaf", () => {
    const catalog = buildRollConfigCatalog();
    const leaves: ConfigCatalogNode[] = [];
    const visit = (node: ConfigCatalogNode): void => {
      if (node.kind === "object") {
        Object.values(node.fields).forEach(visit);
        return;
      }
      if (node.kind === "record") {
        visit(node.value);
        return;
      }
      if (node.kind === "array") {
        visit(node.item);
        return;
      }
      leaves.push(node);
    };
    visit(catalog.root);

    assert.equal(leaves.length, 59);
    for (const leaf of leaves) {
      const path = leaf.path.join(".");
      const guidance = findConfigGuidance(path);
      assert.ok(guidance, `missing guidance for ${path}`);
      assert.ok(guidance.title.trim().length > 0, `missing title for ${path}`);
      assert.match(guidance.title, /\p{Script=Han}/u, `title should explain ${path} in Chinese`);
      assert.ok(guidance.purpose.trim().length > 0, `missing purpose for ${path}`);
      assert.ok(guidance.defaultBehavior?.trim().length, `missing default behavior for ${path}`);
      assert.equal(leaf.title, guidance.title);
      assert.equal(leaf.description, guidance.purpose);
      assert.equal(leaf.defaultBehavior, guidance.defaultBehavior);
    }

    for (const guidance of listConfigGuidanceEntries()) {
      const example = guidance.example;
      assert.ok(example, `missing YAML example for ${guidance.path}`);
      assert.doesNotThrow(() => parseYaml(example), `invalid YAML example for ${guidance.path}`);
    }

    assert.equal(
      findConfigGuidance("runtime.approval.overrides.browser-use-agent.zhipin_send_prepared_reply")
        ?.path,
      "runtime.approval.overrides.<tool>",
    );
  });

  it("derives nested form nodes, defaults, widgets and guidance from the config schema", () => {
    const catalog = buildRollConfigCatalog();

    const timeout = findNode(catalog.root, ["runtime", "turnTimeoutMs"]);
    assert.equal(timeout.kind, "number");
    assert.equal(timeout.widget, "duration");
    assert.equal(timeout.defaultValue, 300_000);
    assert.equal(timeout.persistedRequired, false);
    assert.equal(timeout.kind, "number");
    if (timeout.kind === "number") {
      assert.deepEqual(timeout.constraints, {
        minimum: 10_000,
        exclusiveMinimum: false,
        exclusiveMaximum: false,
        integer: true,
      });
    }

    const threshold = findNode(catalog.root, ["runtime", "compaction", "threshold"]);
    assert.equal(threshold.kind, "number");
    if (threshold.kind === "number") {
      assert.deepEqual(threshold.constraints, {
        minimum: 0.1,
        maximum: 0.95,
        exclusiveMinimum: false,
        exclusiveMaximum: false,
        integer: false,
      });
    }

    const compactionTimeout = findNode(catalog.root, ["runtime", "compaction", "timeoutMs"]);
    assert.equal(compactionTimeout.kind, "number");
    assert.equal(compactionTimeout.widget, "duration");
    assert.equal(compactionTimeout.defaultValue, 120_000);
    if (compactionTimeout.kind === "number") {
      assert.deepEqual(compactionTimeout.constraints, {
        minimum: 10_000,
        maximum: 600_000,
        exclusiveMinimum: false,
        exclusiveMaximum: false,
        integer: true,
      });
    }

    const compactionThinking = findNode(catalog.root, ["runtime", "compaction", "thinkingLevel"]);
    assert.equal(compactionThinking.kind, "enum");
    assert.equal(compactionThinking.defaultValue, undefined);
    assert.equal(compactionThinking.persistedRequired, false);
    assert.match(compactionThinking.defaultBehavior ?? "", /继承 `runtime\.thinking-level`/u);
    if (compactionThinking.kind === "enum") {
      assert.deepEqual(compactionThinking.options, ["off", "low", "medium", "high"]);
    }

    const compactionOutput = findNode(catalog.root, ["runtime", "compaction", "maxOutputTokens"]);
    assert.equal(compactionOutput.kind, "number");
    assert.equal(compactionOutput.defaultValue, 8_192);
    if (compactionOutput.kind === "number") {
      assert.deepEqual(compactionOutput.constraints, {
        minimum: 2_048,
        maximum: 32_768,
        exclusiveMinimum: false,
        exclusiveMaximum: false,
        integer: true,
      });
    }

    const width = findNode(catalog.root, ["browser", "instances", "*", "windowBounds", "width"]);
    assert.equal(width.kind, "number");
    if (width.kind === "number") {
      assert.deepEqual(width.constraints, {
        minimum: 0,
        exclusiveMinimum: true,
        exclusiveMaximum: false,
        integer: true,
      });
    }

    const cdpPort = findNode(catalog.root, ["browser", "instances", "*", "cdpPort"]);
    assert.equal(cdpPort.kind, "number");
    if (cdpPort.kind === "number") {
      assert.equal(cdpPort.constraints.maximum, 65_535);
      assert.equal(cdpPort.constraints.integer, true);
    }

    const approval = findNode(catalog.root, ["runtime", "approval", "default"]);
    assert.equal(approval.kind, "enum");
    if (approval.kind === "enum") {
      assert.deepEqual(approval.options, ["guarded", "auto", "deny"]);
    }

    const skillDirs = findNode(catalog.root, ["skills", "dirs"]);
    assert.equal(skillDirs.kind, "array");
    assert.equal(skillDirs.widget, "string-list");
    assert.match(skillDirs.description ?? "", /标准范围之外/u);

    const browserMode = findNode(catalog.root, ["browser", "instances", "*", "mode"]);
    assert.equal(browserMode.defaultValue, "managed-cdp");
    assert.equal(browserMode.persistedRequired, false);

    const browserDataDir = findNode(catalog.root, ["browser", "instances", "*", "userDataDir"]);
    assert.equal(browserDataDir.defaultValue, undefined);
    assert.equal(browserDataDir.persistedRequired, true);
  });

  it("represents dynamic record keys without flattening dotted names", () => {
    const catalog = buildRollConfigCatalog();

    const providerKey = findNode(catalog.root, ["llm", "providers", "*", "apiKey"]);
    assert.equal(providerKey.kind, "string");
    assert.equal(providerKey.secret, true);
    assert.equal(providerKey.widget, "password");
    assert.match(providerKey.description ?? "", /API key/u);

    const approvalOverride = findNode(catalog.root, ["runtime", "approval", "overrides", "*"]);
    assert.equal(approvalOverride.kind, "enum");

    const cdpUrl = findNode(catalog.root, ["browser", "instances", "*", "cdpUrl"]);
    assert.equal(cdpUrl.kind, "string");
    assert.equal(cdpUrl.secret, true);
    assert.equal(cdpUrl.widget, "password");
  });

  it("derives agent environment fields and marks generated values as read-only", () => {
    const catalog = buildRollConfigCatalog([makeAgent()]);
    const agent = catalog.agents[0];
    assert.ok(agent);
    assert.equal(agent.ownership, "core-managed");

    const token = agent.fields.find((field) => field.name === "REPLY_AUTHORITY_TOKEN");
    assert.ok(token);
    assert.equal(token.required, true);
    assert.equal(token.secret, true);
    assert.equal(token.widget, "password");
    assert.equal(token.secret, true, "legacy declarations fail closed when secret is omitted");

    const url = agent.fields.find((field) => field.name === "REPLY_AUTHORITY_URL");
    assert.ok(url);
    assert.equal(url.type, "url");
    assert.equal(url.widget, "url");

    const derived = agent.fields.find((field) => field.name === "BROWSER_INSTANCES_JSON");
    assert.ok(derived);
    assert.equal(derived.configurable, false);
    assert.deepEqual(derived.sourcePath, ["browser", "instances"]);
  });
});
