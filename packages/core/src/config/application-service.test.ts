import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CONFIG_UI_SECRET_SENTINEL,
  ConfigApplicationService,
  ConfigApplicationValidationError,
  planConfigActivation,
} from "./application-service.ts";
import { createConfigRevision } from "./document-store.ts";

const CONFIG_WITH_SECRETS = `# Roll config
llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers:
    anthropic:
      api-key: sk-plaintext-secret
    openai:
      api-key: \${OPENAI_API_KEY}
ask:
  confirm-threshold: 0.5 # keep this comment
runtime:
  turn-timeout-ms: 300000
agents:
  data-dir: ~/.roll-agent/agents
  env:
    browser-use-agent:
      REPLY_AUTHORITY_BEARER_TOKEN: token-plaintext
      REPLY_AUTHORITY_KEYS_URL: https://example.com/keys
`;

const DYNAMIC_SECRET_MARKERS =
  /base-pass|BASE_QUERY_SECRET|REGISTRY_AUTH_SECRET|UNKNOWN_TOKEN_SECRET|UNKNOWN_API_KEY_SECRET|UNKNOWN_WEBHOOK_SECRET/u;

const RECOVERY_CONFIG = `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
ask: {}
agents:
  data-dir: ~/.roll-agent/agents
`;

function buildConfigWithDynamicSecrets(confirmThreshold: string = "0.5"): string {
  return `${CONFIG_WITH_SECRETS.replace(
    "api-key: sk-plaintext-secret",
    `api-key: sk-plaintext-secret
      base-url: https://base-user:base-pass@example.test/v1?api-version=2026-07-14`,
  )
    .replace(
      /api-key: \$\{OPENAI_API_KEY\}/u,
      `api-key: \${OPENAI_API_KEY}
      base-url: https://example.test/v1?api-version=2026-07-14&access_token=BASE_QUERY_SECRET`,
    )
    .replace("confirm-threshold: 0.5", `confirm-threshold: ${confirmThreshold}`)}install:
  registry: https://registry.example.test/npm?auth=REGISTRY_AUTH_SECRET
future-options:
  access-token: UNKNOWN_TOKEN_SECRET
  api_key: UNKNOWN_API_KEY_SECRET
  deliveryWebhookUrl: https://hooks.example.test/UNKNOWN_WEBHOOK_SECRET
  max-output-tokens: MAX_OUTPUT_TOKENS_VISIBLE
  token-budget: TOKEN_BUDGET_VISIBLE
  secret-rotation: SECRET_ROTATION_VISIBLE
  password-policy: PASSWORD_POLICY_VISIBLE
`;
}

describe("ConfigApplicationService", () => {
  it("returns persisted values without resolving env and redacts plaintext secrets", () => {
    withConfig(CONFIG_WITH_SECRETS, ({ service }) => {
      const snapshot = service.read();
      const llm = requireRecord(snapshot.persisted["llm"]);
      const providers = requireRecord(llm["providers"]);
      const anthropic = requireRecord(providers["anthropic"]);
      const openai = requireRecord(providers["openai"]);

      assert.equal(anthropic["apiKey"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(openai["apiKey"], `\${OPENAI_API_KEY}`);
      assert.doesNotMatch(snapshot.yaml, /sk-plaintext-secret/u);
      assert.doesNotMatch(snapshot.yaml, /token-plaintext/u);
      assert.match(snapshot.yaml, /\$\{OPENAI_API_KEY\}/u);
      assert.match(snapshot.yaml, /~\/\.roll-agent\/agents/u);
      assert.deepEqual(snapshot.configuredSecretPaths, [
        ["llm", "providers", "anthropic", "apiKey"],
        ["llm", "providers", "openai", "apiKey"],
        ["agents", "env", "browser-use-agent", "REPLY_AUTHORITY_BEARER_TOKEN"],
      ]);
    });
  });

  it("previews and saves structured edits while keeping secrets and comments intact", () => {
    withConfig(CONFIG_WITH_SECRETS, ({ configPath, service }) => {
      const snapshot = service.read();
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      const ask = requireMutableRecord(persisted["ask"]);
      ask["confirmThreshold"] = 0.75;

      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.equal(preview.changed, true);
      assert.deepEqual(preview.changedPaths, [["ask", "confirmThreshold"]]);
      assert.equal(preview.effects[0]?.kind, "next-command");
      assert.ok(preview.diff.some((line) => line.kind === "add"));
      assert.doesNotMatch(preview.snapshot.yaml, /sk-plaintext-secret/u);
      assert.doesNotMatch(JSON.stringify(preview.diff), /sk-plaintext-secret/u);
      assert.doesNotMatch(JSON.stringify(preview.diff), /token-plaintext/u);

      const saved = service.saveStructured(persisted, snapshot.revision);
      const actual = readFileSync(configPath, "utf-8");
      assert.match(actual, /^# Roll config/mu);
      assert.match(actual, /confirm-threshold: 0\.75 # keep this comment/u);
      assert.match(actual, /api-key: sk-plaintext-secret/u);
      assert.match(actual, /REPLY_AUTHORITY_BEARER_TOKEN: token-plaintext/u);
      assert.doesNotMatch(actual, new RegExp(CONFIG_UI_SECRET_SENTINEL, "u"));
      assert.ok(saved.backupPath);
      assert.equal(saved.snapshot.existed, true);
    });
  });

  it("round-trips sanitized YAML edits without exposing or replacing existing secrets", () => {
    withConfig(CONFIG_WITH_SECRETS, ({ configPath, service }) => {
      const snapshot = service.read();
      const editedYaml = snapshot.yaml.replace(
        "default-model: claude-sonnet-4-6",
        "default-model: claude-opus-4-6",
      );
      const saved = service.saveYaml(editedYaml, snapshot.revision);
      const actual = readFileSync(configPath, "utf-8");

      assert.match(actual, /default-model: claude-opus-4-6/u);
      assert.match(actual, /api-key: sk-plaintext-secret/u);
      assert.match(actual, /REPLY_AUTHORITY_BEARER_TOKEN: token-plaintext/u);
      assert.doesNotMatch(saved.snapshot.yaml, /sk-plaintext-secret/u);
    });
  });

  it("uses explicit Agent env metadata to redact secrets with non-standard names", () => {
    const raw = CONFIG_WITH_SECRETS.replace(
      "REPLY_AUTHORITY_KEYS_URL: https://example.com/keys",
      `REPLY_AUTHORITY_KEYS_URL: https://example.com/keys
      CUSTOM_CREDENTIAL: opaque-sensitive-value`,
    );
    withConfig(raw, ({ configPath }) => {
      const service = new ConfigApplicationService({
        configPath,
        secretEnvNames: ["CUSTOM_CREDENTIAL"],
      });
      const snapshot = service.read();
      assert.doesNotMatch(snapshot.yaml, /opaque-sensitive-value/u);

      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      requireMutableRecord(persisted["ask"])["confirmThreshold"] = 0.7;
      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), /opaque-sensitive-value/u);

      service.saveStructured(persisted, snapshot.revision);
      assert.match(readFileSync(configPath, "utf-8"), /CUSTOM_CREDENTIAL: opaque-sensitive-value/u);
    });
  });

  it("honors an explicit non-secret Agent env declaration even when its name ends in token", () => {
    const raw = CONFIG_WITH_SECRETS.replace(
      "REPLY_AUTHORITY_KEYS_URL: https://example.com/keys",
      `REPLY_AUTHORITY_KEYS_URL: https://example.com/keys
      PUBLIC_TOKEN: public-display-value
      PUBLIC_ENDPOINT: https://public-user:public-pass@example.test`,
    );
    withConfig(raw, ({ configPath }) => {
      const service = new ConfigApplicationService({
        configPath,
        agentEnvFields: [
          {
            agentName: "browser-use-agent",
            name: "PUBLIC_TOKEN",
            secret: false,
          },
          {
            agentName: "browser-use-agent",
            name: "PUBLIC_ENDPOINT",
            secret: false,
          },
        ],
      });
      const snapshot = service.read();
      const browserEnv = requireRecord(
        requireRecord(requireRecord(snapshot.persisted["agents"])["env"])["browser-use-agent"],
      );

      assert.equal(browserEnv["PUBLIC_TOKEN"], "public-display-value");
      assert.equal(browserEnv["PUBLIC_ENDPOINT"], CONFIG_UI_SECRET_SENTINEL);
      assert.match(snapshot.yaml, /PUBLIC_TOKEN: public-display-value/u);
      assert.doesNotMatch(snapshot.yaml, /public-pass/u);
      assert.equal(
        snapshot.configuredSecretPaths.some(
          (path) => path.join(".") === "agents.env.browser-use-agent.PUBLIC_TOKEN",
        ),
        false,
      );
      assert.equal(
        snapshot.configuredSecretPaths.some(
          (path) => path.join(".") === "agents.env.browser-use-agent.PUBLIC_ENDPOINT",
        ),
        true,
      );
    });
  });

  it("does not treat a secret containing an env interpolation as a safe placeholder", () => {
    const raw = CONFIG_WITH_SECRETS.replace(
      "api-key: sk-plaintext-secret",
      `api-key: plaintext-prefix-\${ANTHROPIC_API_KEY}`,
    );
    withConfig(raw, ({ configPath, service }) => {
      const snapshot = service.read();
      assert.doesNotMatch(snapshot.yaml, /plaintext-prefix/u);
      assert.match(snapshot.yaml, new RegExp(CONFIG_UI_SECRET_SENTINEL, "u"));

      const edited = snapshot.yaml.replace(
        "default-model: claude-sonnet-4-6",
        "default-model: claude-opus-4-6",
      );
      service.saveYaml(edited, snapshot.revision);
      assert.match(
        readFileSync(configPath, "utf-8"),
        /api-key: plaintext-prefix-\$\{ANTHROPIC_API_KEY\}/u,
      );
    });
  });

  it("redacts and restores browser CDP URLs containing credentials and access tokens", () => {
    const cdpUrl = "wss://browser-user:browser-pass@example.test/devtools?token=cdp-secret#session";
    const raw = `${CONFIG_WITH_SECRETS}browser:
  default-instance: remote
  instances:
    remote:
      mode: remote-cdp
      cdp-url: ${cdpUrl}
      user-data-dir: ~/.roll-agent/browser/remote
`;
    withConfig(raw, ({ configPath, service }) => {
      const snapshot = service.read();
      const remote = requireRecord(
        requireRecord(requireRecord(snapshot.persisted["browser"])["instances"])["remote"],
      );

      assert.equal(remote["cdpUrl"], CONFIG_UI_SECRET_SENTINEL);
      assert.ok(
        snapshot.configuredSecretPaths.some(
          (path) => path.join(".") === "browser.instances.remote.cdpUrl",
        ),
      );
      assert.doesNotMatch(JSON.stringify(snapshot), /browser-pass|cdp-secret/u);

      const edited = snapshot.yaml.replace(
        "default-model: claude-sonnet-4-6",
        "default-model: gpt-5",
      );
      const preview = service.previewYaml(edited, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), /browser-pass|cdp-secret/u);
      service.saveYaml(edited, snapshot.revision);
      assert.match(readFileSync(configPath, "utf-8"), /browser-pass@.*token=cdp-secret/u);
    });
  });

  it("redacts terminal-name and credential-bearing URL values without substring false positives", () => {
    withConfig(buildConfigWithDynamicSecrets(), ({ service }) => {
      const snapshot = service.read();
      const serialized = JSON.stringify(snapshot);
      const llm = requireRecord(snapshot.persisted["llm"]);
      const providers = requireRecord(llm["providers"]);
      const anthropic = requireRecord(providers["anthropic"]);
      const openai = requireRecord(providers["openai"]);
      const install = requireRecord(snapshot.persisted["install"]);
      const future = requireRecord(snapshot.persisted["futureOptions"]);

      assert.equal(anthropic["baseUrl"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(openai["baseUrl"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(install["registry"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(future["access-token"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(future["api_key"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(future["deliveryWebhookUrl"], CONFIG_UI_SECRET_SENTINEL);
      assert.equal(future["max-output-tokens"], "MAX_OUTPUT_TOKENS_VISIBLE");
      assert.equal(future["token-budget"], "TOKEN_BUDGET_VISIBLE");
      assert.equal(future["secret-rotation"], "SECRET_ROTATION_VISIBLE");
      assert.equal(future["password-policy"], "PASSWORD_POLICY_VISIBLE");
      assert.doesNotMatch(serialized, DYNAMIC_SECRET_MARKERS);
      assert.match(serialized, /MAX_OUTPUT_TOKENS_VISIBLE|TOKEN_BUDGET_VISIBLE/u);
      assert.ok(
        snapshot.configuredSecretPaths.some(
          (path) => path.join(".") === "llm.providers.anthropic.baseUrl",
        ),
      );
      assert.ok(
        snapshot.configuredSecretPaths.some((path) => path.join(".") === "install.registry"),
      );
    });
  });

  it("keeps dynamic secrets out of structured preview and diff, then restores them on save", () => {
    withConfig(buildConfigWithDynamicSecrets(), ({ configPath, service }) => {
      const snapshot = service.read();
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      requireMutableRecord(persisted["ask"])["confirmThreshold"] = 0.7;

      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), DYNAMIC_SECRET_MARKERS);
      assert.doesNotMatch(JSON.stringify(preview.diff), DYNAMIC_SECRET_MARKERS);

      const saved = service.saveStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(saved), DYNAMIC_SECRET_MARKERS);
      const actual = readFileSync(configPath, "utf-8");
      assert.match(actual, /base-user:base-pass@/u);
      assert.match(actual, /access_token=BASE_QUERY_SECRET/u);
      assert.match(actual, /auth=REGISTRY_AUTH_SECRET/u);
      assert.match(actual, /access-token: UNKNOWN_TOKEN_SECRET/u);
      assert.match(actual, /api_key: UNKNOWN_API_KEY_SECRET/u);
      assert.match(actual, /UNKNOWN_WEBHOOK_SECRET/u);
      assert.doesNotMatch(actual, new RegExp(CONFIG_UI_SECRET_SENTINEL, "u"));
    });
  });

  it("rejects structured sentinels moved away from their original secret path", () => {
    withConfig(buildConfigWithDynamicSecrets(), ({ configPath, service }) => {
      const original = readFileSync(configPath, "utf-8");
      const snapshot = service.read();
      const relocated = structuredClone(snapshot.persisted) as Record<string, unknown>;
      const llm = requireMutableRecord(relocated["llm"]);
      const providers = requireMutableRecord(llm["providers"]);
      const renamed = structuredClone(requireMutableRecord(providers["anthropic"]));
      renamed["apiKey"] = "replacement-key";
      assert.equal(renamed["baseUrl"], CONFIG_UI_SECRET_SENTINEL);
      providers["renamed"] = renamed;
      delete providers["anthropic"];
      llm["defaultProvider"] = "renamed";

      assertUnrestorableSentinelError(
        () => service.saveStructured(relocated, snapshot.revision),
        "llm / providers / renamed / baseUrl",
      );
      assert.equal(readFileSync(configPath, "utf-8"), original);

      const ordinary = structuredClone(snapshot.persisted) as Record<string, unknown>;
      requireMutableRecord(ordinary["ask"])["llmModel"] = CONFIG_UI_SECRET_SENTINEL;
      assertUnrestorableSentinelError(
        () => service.saveStructured(ordinary, snapshot.revision),
        "ask / llmModel",
      );
      assert.equal(readFileSync(configPath, "utf-8"), original);
    });
  });

  it("classifies a newly entered credential URL before preview and restores it on later edits", () => {
    const newBaseUrl =
      "https://candidate-user:candidate-pass@example.test/v1?access_token=CANDIDATE_TOKEN";
    withConfig(CONFIG_WITH_SECRETS, ({ configPath, service }) => {
      const snapshot = service.read();
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      const anthropic = requireMutableRecord(
        requireMutableRecord(requireMutableRecord(persisted["llm"])["providers"])["anthropic"],
      );
      anthropic["baseUrl"] = newBaseUrl;

      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), /candidate-pass|CANDIDATE_TOKEN/u);
      assert.ok(
        preview.snapshot.configuredSecretPaths.some(
          (path) => path.join(".") === "llm.providers.anthropic.baseUrl",
        ),
      );

      const firstSave = service.saveStructured(persisted, snapshot.revision);
      assert.match(readFileSync(configPath, "utf-8"), /candidate-pass@.*CANDIDATE_TOKEN/u);

      const nextPersisted = structuredClone(firstSave.snapshot.persisted) as Record<
        string,
        unknown
      >;
      requireMutableRecord(nextPersisted["ask"])["confirmThreshold"] = 0.72;
      const secondSave = service.saveStructured(nextPersisted, firstSave.snapshot.revision);
      assert.doesNotMatch(JSON.stringify(secondSave), /candidate-pass|CANDIDATE_TOKEN/u);
      assert.match(readFileSync(configPath, "utf-8"), /candidate-pass@.*CANDIDATE_TOKEN/u);
    });
  });

  it("keeps dynamic secrets out of YAML preview and diff, then restores them on save", () => {
    withConfig(buildConfigWithDynamicSecrets(), ({ configPath, service }) => {
      const snapshot = service.read();
      const edited = snapshot.yaml.replace("confirm-threshold: 0.5", "confirm-threshold: 0.8");

      const preview = service.previewYaml(edited, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), DYNAMIC_SECRET_MARKERS);
      assert.doesNotMatch(JSON.stringify(preview.diff), DYNAMIC_SECRET_MARKERS);

      const saved = service.saveYaml(edited, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(saved), DYNAMIC_SECRET_MARKERS);
      const actual = readFileSync(configPath, "utf-8");
      assert.match(actual, /base-user:base-pass@/u);
      assert.match(actual, /access_token=BASE_QUERY_SECRET/u);
      assert.match(actual, /auth=REGISTRY_AUTH_SECRET/u);
      assert.match(actual, /access-token: UNKNOWN_TOKEN_SECRET/u);
      assert.match(actual, /api_key: UNKNOWN_API_KEY_SECRET/u);
      assert.match(actual, /UNKNOWN_WEBHOOK_SECRET/u);
    });
  });

  it("rejects YAML sentinels moved away from their original secret path", () => {
    withConfig(buildConfigWithDynamicSecrets(), ({ configPath, service }) => {
      const original = readFileSync(configPath, "utf-8");
      const snapshot = service.read();
      const originalProvider = `    anthropic:
      api-key: ${CONFIG_UI_SECRET_SENTINEL}
      base-url: ${CONFIG_UI_SECRET_SENTINEL}`;
      const renamedProvider = `    renamed:
      api-key: replacement-key
      base-url: ${CONFIG_UI_SECRET_SENTINEL}`;
      assert.ok(snapshot.yaml.includes(originalProvider));
      const relocated = snapshot.yaml
        .replace("default-provider: anthropic", "default-provider: renamed")
        .replace(originalProvider, renamedProvider);
      assert.ok(relocated.includes(renamedProvider));

      assertUnrestorableSentinelError(
        () => service.saveYaml(relocated, snapshot.revision),
        "llm / providers / renamed / baseUrl",
      );
      assert.equal(readFileSync(configPath, "utf-8"), original);

      const ordinary = snapshot.yaml.replace(
        "ask:\n",
        `ask:\n  llm-model: ${CONFIG_UI_SECRET_SENTINEL}\n`,
      );
      assert.notEqual(ordinary, snapshot.yaml);
      assertUnrestorableSentinelError(
        () => service.saveYaml(ordinary, snapshot.revision),
        "ask / llmModel",
      );
      assert.equal(readFileSync(configPath, "utf-8"), original);
    });
  });

  it("keeps dynamic secrets protected through repair preview, diff, and save", () => {
    withConfig(buildConfigWithDynamicSecrets("invalid"), ({ configPath, service }) => {
      const snapshot = service.readForRepair();
      assert.doesNotMatch(JSON.stringify(snapshot), DYNAMIC_SECRET_MARKERS);
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      requireMutableRecord(persisted["ask"])["confirmThreshold"] = 0.65;

      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), DYNAMIC_SECRET_MARKERS);
      assert.doesNotMatch(JSON.stringify(preview.diff), DYNAMIC_SECRET_MARKERS);

      const saved = service.saveStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(saved), DYNAMIC_SECRET_MARKERS);
      const actual = readFileSync(configPath, "utf-8");
      assert.match(actual, /confirm-threshold: 0\.65/u);
      assert.match(actual, /base-user:base-pass@/u);
      assert.match(actual, /access_token=BASE_QUERY_SECRET/u);
      assert.match(actual, /auth=REGISTRY_AUTH_SECRET/u);
      assert.match(actual, /access-token: UNKNOWN_TOKEN_SECRET/u);
    });
  });

  it("redacts an entire malformed secret subtree while in repair mode", () => {
    const raw = `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers:
    anthropic:
      api-key:
        nested: LLM_PLAINTEXT_SECRET
ask:
  confirm-threshold: invalid
agents:
  data-dir: ~/.roll-agent/agents
  env:
    demo-agent:
      ACCESS_TOKEN:
        nested: AGENT_PLAINTEXT_SECRET
`;
    withConfig(raw, ({ service }) => {
      const snapshot = service.readForRepair();
      const serialized = JSON.stringify(snapshot);

      assert.doesNotMatch(serialized, /LLM_PLAINTEXT_SECRET|AGENT_PLAINTEXT_SECRET/u);
      assert.equal(
        requireRecord(
          requireRecord(requireRecord(snapshot.persisted["llm"])["providers"])["anthropic"],
        )["apiKey"],
        CONFIG_UI_SECRET_SENTINEL,
      );
      assert.equal(
        requireRecord(
          requireRecord(requireRecord(snapshot.persisted["agents"])["env"])["demo-agent"],
        )["ACCESS_TOKEN"],
        CONFIG_UI_SECRET_SENTINEL,
      );
    });
  });

  it("redacts newly added undeclared Agent env values before returning a preview", () => {
    withConfig(CONFIG_WITH_SECRETS, ({ configPath }) => {
      const service = new ConfigApplicationService({
        configPath,
        redactUnknownAgentEnv: true,
        agentEnvFields: [
          {
            agentName: "browser-use-agent",
            name: "REPLY_AUTHORITY_BEARER_TOKEN",
            secret: true,
          },
          {
            agentName: "browser-use-agent",
            name: "REPLY_AUTHORITY_KEYS_URL",
            secret: false,
          },
        ],
      });
      const snapshot = service.read();
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      const browserEnv = requireMutableRecord(
        requireMutableRecord(requireMutableRecord(persisted["agents"])["env"])["browser-use-agent"],
      );
      browserEnv["NEW_UNDECLARED_CREDENTIAL"] = "candidate-plaintext-secret";

      const preview = service.previewStructured(persisted, snapshot.revision);
      assert.doesNotMatch(JSON.stringify(preview), /candidate-plaintext-secret/u);
      assert.equal(
        requireRecord(
          requireRecord(requireRecord(preview.snapshot.persisted["agents"])["env"])[
            "browser-use-agent"
          ],
        )["NEW_UNDECLARED_CREDENTIAL"],
        CONFIG_UI_SECRET_SENTINEL,
      );

      service.saveStructured(persisted, snapshot.revision);
      assert.match(readFileSync(configPath, "utf-8"), /candidate-plaintext-secret/u);
    });
  });

  it("returns structured validation issues from the existing Zod pipeline", () => {
    withConfig(CONFIG_WITH_SECRETS, ({ service }) => {
      const snapshot = service.read();
      const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
      const runtime = requireMutableRecord(persisted["runtime"]);
      runtime["turnTimeoutMs"] = 100;

      assert.throws(
        () => service.previewStructured(persisted, snapshot.revision),
        (error: unknown) =>
          error instanceof ConfigApplicationValidationError &&
          error.issues.some(
            (issue) => issue.path === "runtime.turnTimeoutMs" && issue.message.includes("10000"),
          ),
      );
    });
  });

  it("validates and replaces an invalid document only through the init recovery API", () => {
    const invalidRaw = "llm: [\n";
    withConfig(invalidRaw, ({ configPath, service }) => {
      const result = service.replaceYamlForInit(RECOVERY_CONFIG, createConfigRevision(invalidRaw));

      assert.equal(result.changed, true);
      assert.equal(readFileSync(configPath, "utf-8"), RECOVERY_CONFIG);
      assert.ok(result.backupPath);
      assert.equal(readFileSync(result.backupPath, "utf-8"), invalidRaw);
      assert.equal(requireRecord(result.snapshot.persisted["llm"])["defaultProvider"], "anthropic");
    });
  });

  it("does not replace an invalid document with a schema-invalid init candidate", () => {
    const invalidRaw = "llm: [\n";
    const invalidCandidate = RECOVERY_CONFIG.replace(
      "ask: {}",
      "ask: {}\nruntime:\n  turn-timeout-ms: 100",
    );
    withConfig(invalidRaw, ({ configPath, service }) => {
      assert.throws(
        () => service.replaceYamlForInit(invalidCandidate, createConfigRevision(invalidRaw)),
        ConfigApplicationValidationError,
      );
      assert.equal(readFileSync(configPath, "utf-8"), invalidRaw);
    });
  });

  it("plans restart, new-session, next-command and manual effects from segment paths", () => {
    const effects = planConfigActivation([
      ["browser", "instances", "boss-a", "cdpPort"],
      ["agents", "env", "notify-agent", "FEISHU_BOT_WEBHOOK"],
      ["agents", "dataDir"],
      ["chat", "screenMode"],
      ["runtime", "turnTimeoutMs"],
      ["llm", "defaultModel"],
    ]);

    assert.ok(
      effects.some(
        (effect) => effect.kind === "restart-agent" && effect.agentName === "browser-use-agent",
      ),
    );
    assert.ok(
      effects.some(
        (effect) => effect.kind === "restart-agent" && effect.agentName === "notify-agent",
      ),
    );
    assert.ok(effects.some((effect) => effect.kind === "manual"));
    const nextChat = effects.find((effect) => effect.kind === "next-chat");
    assert.ok(nextChat);
    assert.deepEqual(nextChat.paths, [
      ["chat", "screenMode"],
      ["runtime", "turnTimeoutMs"],
    ]);
    assert.ok(effects.some((effect) => effect.kind === "next-command"));
  });

  it("plans scheduler effects that point at service restart", () => {
    const effects = planConfigActivation([
      ["scheduler", "dataDir"],
      ["scheduler", "maxConcurrentRuns"],
      ["scheduler", "maxSchedules"],
    ]);

    const dataDir = effects.find((effect) =>
      effect.paths.some((path) => path[0] === "scheduler" && path[1] === "dataDir"),
    );
    assert.ok(dataDir);
    assert.equal(dataDir.kind, "manual");
    assert.equal(dataDir.requiresConfirmation, true);
    assert.match(dataDir.description, /不会搬迁/u);
    assert.match(dataDir.description, /roll schedule service restart/u);

    const concurrent = effects.find((effect) =>
      effect.paths.some((path) => path[0] === "scheduler" && path[1] === "maxConcurrentRuns"),
    );
    assert.ok(concurrent);
    assert.equal(concurrent.kind, "manual");
    assert.notEqual(concurrent.title, dataDir.title);
    assert.match(concurrent.description, /roll schedule service restart/u);
    assert.match(concurrent.description, /不会重置/u);

    const maxSchedules = effects.find((effect) =>
      effect.paths.some((path) => path[0] === "scheduler" && path[1] === "maxSchedules"),
    );
    assert.ok(maxSchedules);
    assert.equal(maxSchedules.kind, "next-command");
  });
});

function withConfig(
  raw: string,
  callback: (context: {
    readonly configPath: string;
    readonly service: ConfigApplicationService;
  }) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "roll-config-service-"));
  try {
    const configPath = join(directory, "roll.config.yaml");
    writeFileSync(configPath, raw, "utf-8");
    callback({
      configPath,
      service: new ConfigApplicationService({ configPath }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

function requireMutableRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertUnrestorableSentinelError(action: () => unknown, expectedPath: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConfigApplicationValidationError);
    assert.ok(error.message.includes(expectedPath));
    assert.doesNotMatch(error.message, DYNAMIC_SECRET_MARKERS);
    return true;
  });
}
