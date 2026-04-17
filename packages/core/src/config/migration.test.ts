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
    assert.match(report.issues.map((issue) => issue.message).join("\n"), /`router` 配置段已废弃/);
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
    assert.match(result.issues.map((issue) => issue.message).join("\n"), /值冲突/);
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

  it("detects camelCase agents.env keys and auto-migrates to kebab-case", () => {
    const report = detectKnownConfigMigrations({
      agents: {
        env: {
          smartReplyAgent: { REPLY_AUTHORITY_URL: "https://x" },
          browserUseAgent: { REPLY_AUTHORITY_KEYS_URL: "https://y" },
        },
      },
    });

    assert.equal(report.needsMigration, true);
    assert.equal(report.canAutoMigrate, true);
    assert.match(
      report.issues.map((issue) => issue.message).join("\n"),
      /agents\.env\.smartReplyAgent.*smart-reply-agent/,
    );
  });

  it("auto-migrates camelCase agents.env keys to kebab-case", () => {
    const result = applyKnownConfigMigrations({
      agents: {
        env: {
          smartReplyAgent: { REPLY_AUTHORITY_URL: "https://x" },
          "already-kebab-agent": { FOO: "bar" },
        },
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    const env = (result.document["agents"] as { env: Record<string, unknown> }).env;
    assert.ok("smart-reply-agent" in env);
    assert.equal("smartReplyAgent" in env, false);
    assert.ok("already-kebab-agent" in env);
    assert.match(result.summary.join("\n"), /smartReplyAgent.*smart-reply-agent/);
  });

  it("fails auto migration when camelCase and kebab-case agents.env keys conflict", () => {
    const result = applyKnownConfigMigrations({
      agents: {
        env: {
          smartReplyAgent: { REPLY_AUTHORITY_URL: "https://x" },
          "smart-reply-agent": { REPLY_AUTHORITY_URL: "https://y" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.issues.map((issue) => issue.message).join("\n"), /无法自动合并/);
  });

  it("flags lowercase but non-canonical agent keys (underscore) as blocking", () => {
    const result = applyKnownConfigMigrations({
      agents: {
        env: {
          smart_reply_agent: { REPLY_AUTHORITY_URL: "https://x" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(
      result.issues.map((issue) => issue.message).join("\n"),
      /smart_reply_agent.*无法自动迁移/,
    );
  });

  it("flags mixed-case-with-hyphen agent keys as blocking (cannot auto-migrate)", () => {
    const result = applyKnownConfigMigrations({
      agents: {
        env: {
          "smart-Reply-agent": { REPLY_AUTHORITY_URL: "https://x" },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(
      result.issues.map((issue) => issue.message).join("\n"),
      /smart-Reply-agent.*无法自动迁移/,
    );
  });

  it("scope:agents filter ignores router-to-ask rule", () => {
    const report = detectKnownConfigMigrations(
      {
        router: { "llm-model": "claude-sonnet-4-6" },
        agents: { env: { "smart-reply-agent": { X: "y" } } },
      },
      { scope: "agents" },
    );
    assert.equal(report.needsMigration, false);
  });

  it("scope:ask filter ignores legacy-agent-env-keys rule", () => {
    const report = detectKnownConfigMigrations(
      {
        router: { "llm-model": "claude-sonnet-4-6" },
        agents: { env: { smartReplyAgent: { X: "y" } } },
      },
      { scope: "ask" },
    );
    assert.equal(report.needsMigration, true);
    assert.match(report.issues.map((issue) => issue.message).join("\n"), /`router` 配置段已废弃/);
    assert.equal(
      report.issues.some((issue) => /agents\.env/.test(issue.message)),
      false,
    );
  });

  it("does not flag non-agent.env sections with camelCase keys", () => {
    const report = detectKnownConfigMigrations({
      agents: {
        env: {
          "smart-reply-agent": { REPLY_AUTHORITY_URL: "https://x" },
        },
      },
    });

    assert.equal(report.needsMigration, false);
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
