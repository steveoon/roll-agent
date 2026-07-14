import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConfigActivationEffect } from "../config/application-service.ts";
import type { ConfigRevision } from "../config/document-store.ts";
import type { RollConfig } from "../config/schema.ts";
import type {
  AgentActivationResult,
  AgentLifecycleBaseline,
  AgentLifecycleInspection,
} from "../registry/agent-lifecycle.ts";
import { AgentStore } from "../registry/store.ts";
import type { RegisteredAgent } from "../types/agent.ts";
import {
  RollUiActivationInProgressError,
  createRollUiRuntimeController,
} from "./runtime-controller.ts";

describe("createRollUiRuntimeController", () => {
  it("reuses Agent env metadata, saves safely, and applies only the trusted saved plan", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const harness = createLifecycleHarness(agent, dataDir);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
        now: () => new Date("2026-07-14T04:00:00.000Z"),
      });

      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const persisted = requireRecord(snapshot.persisted);
      const configuredEnv = requireRecord(
        requireRecord(requireRecord(persisted.agents).env)[agent.skill.name],
      );
      assert.equal(configuredEnv.CUSTOM_CREDENTIAL, "__ROLL_UI_KEEP_EXISTING_SECRET__");

      const catalog = await controller.getCatalog();
      assert.ok(isRecord(catalog));
      assert.ok(Array.isArray(catalog.agents));
      assert.equal(catalog.agents.length, 1);

      const edited = structuredClone(persisted) as Record<string, unknown>;
      requireMutableRecord(
        requireMutableRecord(requireMutableRecord(edited.agents).env)[agent.skill.name],
      ).DISPLAY_MODE = "compact";
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      assert.ok(Array.isArray(saved.effects));
      assert.equal(harness.captureCalls, 1);

      const trustedEffects = saved.effects as readonly ConfigActivationEffect[];
      const tampered = await controller.applyAgentEffects({ effects: [] });
      assert.ok(isRecord(tampered));
      assert.equal(tampered.applied, false);
      assert.equal(harness.applyCalls.length, 0);

      const applied = await controller.applyAgentEffects({ effects: trustedEffects });
      assert.ok(isRecord(applied));
      assert.equal(applied.applied, true);
      assert.equal(harness.applyCalls.length, 1);
      assert.deepEqual(harness.applyCalls[0]?.effects, trustedEffects);
      assert.equal(
        harness.applyCalls[0]?.effectiveConfig.agents.env?.[agent.skill.name]?.DISPLAY_MODE,
        "compact",
      );
      assert.match(String(applied.message), /重启/u);
      assert.match(readFileSync(configPath, "utf-8"), /CUSTOM_CREDENTIAL: original-secret/u);
    });
  });

  it("refuses to apply a pending plan after the config revision changes again", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const harness = createLifecycleHarness(agent, dataDir);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const persisted = structuredClone(requireRecord(snapshot.persisted)) as Record<
        string,
        unknown
      >;
      requireMutableRecord(persisted.ask).confirmThreshold = 0.65;
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      const effects = saved.effects as readonly ConfigActivationEffect[];
      writeFileSync(configPath, `${readFileSync(configPath, "utf-8")}# external edit\n`);

      const result = await controller.applyAgentEffects({ effects });
      assert.ok(isRecord(result));
      assert.equal(result.applied, false);
      assert.match(String(result.message), /再次变化/u);
      assert.equal(harness.applyCalls.length, 0);
    });
  });

  it("preserves the last saved activation plan when a later save fails validation", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const harness = createLifecycleHarness(agent, dataDir);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const edited = structuredClone(requireRecord(snapshot.persisted)) as Record<string, unknown>;
      requireMutableRecord(edited.ask).confirmThreshold = 0.65;
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      const effects = saved.effects as readonly ConfigActivationEffect[];
      const savedSnapshot = requireRecord(saved.snapshot);
      const invalid = structuredClone(requireRecord(savedSnapshot.persisted)) as Record<
        string,
        unknown
      >;
      requireMutableRecord(invalid.ask).confirmThreshold = "invalid";

      assert.throws(() =>
        controller.saveConfig({
          mode: "structured",
          persisted: invalid,
          expectedRevision: requireConfigRevision(savedSnapshot.revision),
        }),
      );

      const applied = await controller.applyAgentEffects({ effects });
      assert.ok(isRecord(applied));
      assert.equal(applied.applied, true);
      assert.equal(harness.applyCalls.length, 1);
    });
  });

  it("preserves the last saved activation plan across a no-op save retry", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const harness = createLifecycleHarness(agent, dataDir);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const edited = structuredClone(requireRecord(snapshot.persisted)) as Record<string, unknown>;
      requireMutableRecord(edited.ask).confirmThreshold = 0.65;
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      const effects = saved.effects as readonly ConfigActivationEffect[];
      const savedSnapshot = requireRecord(saved.snapshot);

      const retried = await controller.saveConfig({
        mode: "structured",
        persisted: requireRecord(savedSnapshot.persisted),
        expectedRevision: requireConfigRevision(savedSnapshot.revision),
      });
      assert.ok(isRecord(retried));
      assert.equal(retried.changed, false);

      const applied = await controller.applyAgentEffects({ effects });
      assert.ok(isRecord(applied));
      assert.equal(applied.applied, true);
      assert.equal(harness.applyCalls.length, 1);
    });
  });

  it("consumes a saved activation plan atomically and rejects saves while it is applying", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const gate = createDeferred();
      const harness = createLifecycleHarness(agent, dataDir, undefined, gate.promise);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const edited = structuredClone(requireRecord(snapshot.persisted)) as Record<string, unknown>;
      requireMutableRecord(edited.ask).confirmThreshold = 0.65;
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      const effects = saved.effects as readonly ConfigActivationEffect[];

      const firstApply = controller.applyAgentEffects({ effects });
      assert.equal(harness.applyCalls.length, 1);

      const duplicateApply = await controller.applyAgentEffects({ effects });
      assert.ok(isRecord(duplicateApply));
      assert.equal(duplicateApply.attempted, false);
      assert.equal(harness.applyCalls.length, 1);
      assert.match(String(duplicateApply.message), /没有重复应用/u);

      const savedSnapshot = requireRecord(saved.snapshot);
      const nextConfig = structuredClone(requireRecord(savedSnapshot.persisted)) as Record<
        string,
        unknown
      >;
      requireMutableRecord(nextConfig.ask).confirmThreshold = 0.7;
      assert.throws(
        () =>
          controller.saveConfig({
            mode: "structured",
            persisted: nextConfig,
            expectedRevision: requireConfigRevision(savedSnapshot.revision),
          }),
        RollUiActivationInProgressError,
      );

      gate.resolve();
      const applied = await firstApply;
      assert.ok(isRecord(applied));
      assert.equal(applied.attempted, true);
      assert.equal(harness.applyCalls.length, 1);

      const savedAfterApply = await controller.saveConfig({
        mode: "structured",
        persisted: nextConfig,
        expectedRevision: requireConfigRevision(savedSnapshot.revision),
      });
      assert.ok(isRecord(savedAfterApply));
      assert.equal(savedAfterApply.changed, true);
    });
  });

  it("opens schema-invalid YAML in repair mode without exposing unknown Agent env values", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      writeFileSync(
        configPath,
        `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
ask:
  confirm-threshold: invalid
agents:
  data-dir: ${dataDir}
  env:
    ${agent.skill.name}:
      CUSTOM_CREDENTIAL: original-secret
      UNDECLARED_VALUE: unknown-private-value
`,
      );
      const harness = createLifecycleHarness(agent, dataDir);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });

      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      assert.equal(snapshot.repairMode, true);
      assert.ok(Array.isArray(snapshot.validationIssues));
      const publicYaml = requireString(snapshot.yaml);
      assert.doesNotMatch(publicYaml, /unknown-private-value/u);
      assert.match(publicYaml, /__ROLL_UI_KEEP_EXISTING_SECRET__/u);

      const saved = await controller.saveConfig({
        mode: "yaml",
        yaml: publicYaml.replace("confirm-threshold: invalid", "confirm-threshold: 0.7"),
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));
      const persistedYaml = readFileSync(configPath, "utf-8");
      assert.match(persistedYaml, /confirm-threshold: 0.7/u);
      assert.match(persistedYaml, /UNDECLARED_VALUE: unknown-private-value/u);
    });
  });

  it("reports a failed restart as unsuccessful and preserves the structured result", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const harness = createLifecycleHarness(agent, dataDir, {
        success: false,
        requiresManualAction: true,
        restartedAgentNames: [],
        items: [
          {
            effect: {
              kind: "restart-agent",
              paths: [["agents", "env", agent.skill.name, "DISPLAY_MODE"]],
              title: `重启 ${agent.skill.name}`,
              description: "Restart",
              agentName: agent.skill.name,
              requiresConfirmation: true,
            },
            status: "failed",
            message: "readiness failed",
          },
        ],
      });
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => harness.port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const edited = structuredClone(requireRecord(snapshot.persisted)) as Record<string, unknown>;
      requireMutableRecord(
        requireMutableRecord(requireMutableRecord(edited.agents).env)[agent.skill.name],
      ).DISPLAY_MODE = "compact";
      const saved = await controller.saveConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(saved));

      const result = await controller.applyAgentEffects({
        effects: saved.effects as readonly ConfigActivationEffect[],
      });
      assert.ok(isRecord(result));
      assert.equal(result.attempted, true);
      assert.equal(result.applied, false);
      assert.ok(isRecord(result.result));
      assert.equal(result.result.success, false);
      assert.match(String(result.message), /readiness failed/u);
    });
  });

  it("describes on-demand and external-managed Agent env activation accurately", async () => {
    await withFixture(async ({ agent, configPath, dataDir }) => {
      const store = new AgentStore(dataDir);
      const onDemand = createOwnedAgent("on-demand-agent", "on-demand");
      const external = createOwnedAgent("external-agent", "external-managed");
      store.add(onDemand);
      store.add(external);
      const controller = createRollUiRuntimeController({
        configPath,
        createLifecycle: () => createLifecycleHarness(agent, dataDir).port,
      });
      const snapshot = await controller.getConfig();
      assert.ok(isRecord(snapshot));
      const edited = structuredClone(requireRecord(snapshot.persisted)) as Record<string, unknown>;
      const env = requireMutableRecord(requireMutableRecord(edited.agents).env);
      env[onDemand.skill.name] = { MODE: "fast" };
      env[external.skill.name] = { MODE: "safe" };

      const preview = await controller.previewConfig({
        mode: "structured",
        persisted: edited,
        expectedRevision: requireConfigRevision(snapshot.revision),
      });
      assert.ok(isRecord(preview));
      assert.ok(Array.isArray(preview.effects));
      const effects = preview.effects.filter(isRecord);
      assert.ok(
        effects.some(
          (effect) => effect.agentName === onDemand.skill.name && effect.kind === "next-command",
        ),
      );
      assert.ok(
        effects.some(
          (effect) => effect.agentName === external.skill.name && effect.kind === "manual",
        ),
      );
    });
  });
});

interface FixtureContext {
  readonly agent: RegisteredAgent;
  readonly configPath: string;
  readonly dataDir: string;
}

function withFixture(callback: (context: FixtureContext) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "roll-ui-runtime-controller-"));
  const dataDir = join(directory, "agents");
  const configPath = join(directory, "roll.config.yaml");
  const agent = createAgent();
  new AgentStore(dataDir).add(agent);
  writeFileSync(
    configPath,
    `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
  env:
    ${agent.skill.name}:
      CUSTOM_CREDENTIAL: original-secret
`,
  );
  return callback({ agent, configPath, dataDir }).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

interface ApplyCall {
  readonly effects: readonly ConfigActivationEffect[];
  readonly baseline: AgentLifecycleBaseline;
  readonly effectiveConfig: RollConfig;
}

function createLifecycleHarness(
  agent: RegisteredAgent,
  dataDir: string,
  activationResult: AgentActivationResult | undefined = undefined,
  waitBeforeResult?: Promise<void>,
) {
  const resolvedActivationResult: AgentActivationResult = activationResult ?? {
    success: true,
    requiresManualAction: false,
    restartedAgentNames: [agent.skill.name],
    items: [],
  };
  const applyCalls: ApplyCall[] = [];
  let captureCalls = 0;
  const baseline: AgentLifecycleBaseline = {
    dataDir,
    capturedAt: "2026-07-14T03:59:00.000Z",
    agents: { [agent.skill.name]: { agent, pid: 42 } },
  };
  const inspection: AgentLifecycleInspection = {
    agentName: agent.skill.name,
    ownership: "core-managed",
    transport: "streamable-http",
    state: "running",
    endpointReachable: true,
    canAutoRestart: true,
    pid: 42,
    endpoint: "http://127.0.0.1:3900/mcp",
    message: "Agent online",
  };
  return {
    applyCalls,
    get captureCalls() {
      return captureCalls;
    },
    port: {
      inspectAll: async () => [inspection],
      captureBaseline: () => {
        captureCalls += 1;
        return baseline;
      },
      applyActivation: async (
        effects: readonly ConfigActivationEffect[],
        capturedBaseline: AgentLifecycleBaseline,
        effectiveConfig: RollConfig,
      ) => {
        applyCalls.push({ effects, baseline: capturedBaseline, effectiveConfig });
        await waitBeforeResult;
        return resolvedActivationResult;
      },
    },
  };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      assert.ok(resolvePromise);
      resolvePromise();
    },
  };
}

function createAgent(): RegisteredAgent {
  return {
    skill: {
      name: "notify-agent",
      description: "Notification Agent",
      metadata: {},
      env: {
        required: [
          {
            name: "CUSTOM_CREDENTIAL",
            purpose: "A secret whose name does not match the fallback heuristic",
            secret: true,
          },
        ],
        optional: [{ name: "DISPLAY_MODE" }],
      },
    },
    transport: { type: "streamable-http", endpoint: "http://127.0.0.1:3900/mcp" },
    runtime: {
      ownership: "core-managed",
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: "/mcp", port: 3900 },
    },
    installPath: "/tmp/notify-agent",
    registeredAt: "2026-07-14T00:00:00.000Z",
    status: "online",
  };
}

function createOwnedAgent(
  name: string,
  ownership: RegisteredAgent["runtime"]["ownership"],
): RegisteredAgent {
  const shared = {
    skill: {
      name,
      description: `${name} fixture`,
      metadata: {},
      env: { optional: [{ name: "MODE", secret: false }] },
    },
    installPath: `/tmp/${name}`,
    registeredAt: "2026-07-14T00:00:00.000Z",
    status: "stopped" as const,
  };
  if (ownership === "on-demand") {
    return {
      ...shared,
      transport: { type: "stdio", command: "node", args: ["dist/index.js"] },
      runtime: { ownership },
    };
  }
  if (ownership === "external-managed") {
    return {
      ...shared,
      transport: { type: "streamable-http", endpoint: `http://127.0.0.1/${name}` },
      runtime: { ownership },
    };
  }
  return {
    ...shared,
    transport: { type: "streamable-http", endpoint: `http://127.0.0.1/${name}` },
    runtime: {
      ownership,
      start: { command: "node", args: ["dist/index.js"] },
      endpoint: { path: `/${name}`, port: 3999 },
    },
  };
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(isRecord(value));
  return value;
}

function requireMutableRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value as Record<string, unknown>;
}

function requireConfigRevision(value: unknown): ConfigRevision {
  assert.equal(typeof value, "string");
  return value as ConfigRevision;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") assert.fail("expected string");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
