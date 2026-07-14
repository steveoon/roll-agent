import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ConfigApplicationPreview,
  ConfigApplicationSaveResult,
  ConfigApplicationSnapshot,
} from "../config/application-service.ts";
import { createConfigRevision } from "../config/document-store.ts";
import { createConfigApplicationUiController } from "./config-controller.ts";

const TEST_REVISION = createConfigRevision("current");
const TEST_SNAPSHOT: ConfigApplicationSnapshot = {
  configPath: "/tmp/roll.config.yaml",
  existed: true,
  revision: TEST_REVISION,
  persisted: {},
  yaml: "{}\n",
  configuredSecretPaths: [],
};
const TEST_PREVIEW: ConfigApplicationPreview = {
  snapshot: TEST_SNAPSHOT,
  changed: false,
  changedPaths: [],
  effects: [],
  diff: [],
};
const TEST_SAVE_RESULT: ConfigApplicationSaveResult = TEST_PREVIEW;

describe("createConfigApplicationUiController", () => {
  it("dispatches structured and YAML operations to ConfigApplicationService", async () => {
    const revision = TEST_REVISION;
    const calls: string[] = [];
    const controller = createConfigApplicationUiController({
      config: {
        read: () => TEST_SNAPSHOT,
        previewStructured: (persisted, expectedRevision) => {
          calls.push(`preview-structured:${String(expectedRevision)}:${String(persisted)}`);
          return TEST_PREVIEW;
        },
        previewYaml: (yaml, expectedRevision) => {
          calls.push(`preview-yaml:${String(expectedRevision)}:${yaml}`);
          return TEST_PREVIEW;
        },
        saveStructured: (persisted, expectedRevision) => {
          calls.push(`save-structured:${String(expectedRevision)}:${String(persisted)}`);
          return TEST_SAVE_RESULT;
        },
        saveYaml: (yaml, expectedRevision) => {
          calls.push(`save-yaml:${String(expectedRevision)}:${yaml}`);
          return TEST_SAVE_RESULT;
        },
      },
      getCatalog: () => ({ schemaVersion: 1 }),
    });

    assert.deepEqual(await controller.getConfig(), TEST_SNAPSHOT);
    assert.deepEqual(await controller.getCatalog(), { schemaVersion: 1 });
    assert.deepEqual(
      await controller.previewConfig({
        mode: "structured",
        persisted: { runtime: {} },
        expectedRevision: revision,
      }),
      TEST_PREVIEW,
    );
    assert.deepEqual(
      await controller.previewConfig({ mode: "yaml", yaml: "runtime: {}\n" }),
      TEST_PREVIEW,
    );
    assert.deepEqual(
      await controller.saveConfig({
        mode: "structured",
        persisted: {},
        expectedRevision: revision,
      }),
      TEST_SAVE_RESULT,
    );
    assert.deepEqual(
      await controller.saveConfig({
        mode: "yaml",
        yaml: "runtime: {}\n",
        expectedRevision: revision,
      }),
      TEST_SAVE_RESULT,
    );
    assert.equal(calls.length, 4);
  });

  it("returns explicit unavailable results when lifecycle hooks are absent", async () => {
    const controller = createConfigApplicationUiController({
      config: {
        read: () => TEST_SNAPSHOT,
        previewStructured: () => TEST_PREVIEW,
        previewYaml: () => TEST_PREVIEW,
        saveStructured: () => TEST_SAVE_RESULT,
        saveYaml: () => TEST_SAVE_RESULT,
      },
      getCatalog: () => ({}),
    });
    const effect = {
      kind: "next-chat" as const,
      paths: [["runtime", "turnTimeoutMs"]],
      title: "New chat",
      description: "Applies to a new chat.",
      requiresConfirmation: false,
    };

    assert.deepEqual(await controller.getAgentStatus(), { available: false, agents: [] });
    assert.deepEqual(await controller.applyAgentEffects({ effects: [effect] }), {
      available: false,
      applied: [],
      skipped: [effect],
      reason: "Agent lifecycle adapter is not configured.",
    });
  });
});
