import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyKnownConfigMigrations, detectKnownConfigMigrations } from "./migration.ts";

describe("config migration", () => {
  it("detects deprecated router config and supports auto migration", () => {
    const report = detectKnownConfigMigrations({
      llm: { "default-provider": "anthropic" },
      router: {
        "llm-model": "claude-sonnet-4-6",
        "confirm-threshold": 0.5,
        mode: "declarative",
      },
    });

    assert.equal(report.needsMigration, true);
    assert.equal(report.canAutoMigrate, true);
    assert.match(
      report.issues.map((issue) => issue.message).join("\n"),
      /`router` 配置段已废弃/,
    );
  });

  it("fails auto migration when router and ask values conflict", () => {
    const result = applyKnownConfigMigrations({
      router: {
        "llm-model": "claude-sonnet-4-6",
      },
      ask: {
        "llm-model": "gpt-4.1-mini",
      },
    });

    assert.equal(result.ok, false);
    assert.match(
      result.issues.map((issue) => issue.message).join("\n"),
      /值冲突/,
    );
  });

  it("moves router keys into ask and deletes deprecated router section", () => {
    const result = applyKnownConfigMigrations({
      router: {
        "llm-model": "claude-sonnet-4-6",
        "confirm-threshold": 0.5,
        mode: "declarative",
      },
      agents: {
        "data-dir": "~/.roll-agent/agents",
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.document["router"], undefined);
    assert.deepEqual(result.document["ask"], {
      "llm-model": "claude-sonnet-4-6",
      "confirm-threshold": 0.5,
    });
    assert.match(result.summary.join("\n"), /router\.llm-model/);
    assert.match(result.summary.join("\n"), /删除空的 `router` 配置段/);
  });

  it("supports camelCase legacy keys during migration", () => {
    const result = applyKnownConfigMigrations({
      router: {
        llmModel: "claude-sonnet-4-6",
        confirmThreshold: 0.5,
      },
      ask: {},
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.deepEqual(result.document["ask"], {
      "llm-model": "claude-sonnet-4-6",
      "confirm-threshold": 0.5,
    });
    assert.equal(result.document["router"], undefined);
  });
});
