import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConfigApplicationService,
  ConfigApplicationValidationError,
} from "../config/application-service.ts";
import { validateConfigText } from "../config/loader.ts";
import { createRollUiRuntimeController } from "./runtime-controller.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "roll-ui-thinking-"));
  const configPath = join(directory, "roll.config.yaml");
  const initial = {
    llm: { defaultProvider: "openai", defaultModel: "fixture", providers: {} },
    ask: {},
    agents: { dataDir: join(directory, "agents") },
    runtime: { provider: "chatgpt", model: "fixture" },
  };
  writeFileSync(configPath, JSON.stringify(initial));
  return {
    configPath,
    initial,
    snapshot: () => new ConfigApplicationService({ configPath }).read(),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("UI Fast preview/save rejects unsupported models and persists the explicit supported preference", async () => {
  const f = fixture();
  let supportsFastMode = false;
  try {
    const controller = createRollUiRuntimeController({
      configPath: f.configPath,
      getChatGptModels: () => [{ slug: "fixture", displayName: "Fixture", supportsFastMode }],
    });
    const request = {
      mode: "structured" as const,
      expectedRevision: f.snapshot().revision,
      persisted: { ...f.initial, runtime: { ...f.initial.runtime, fastMode: true } },
    };
    const before = readFileSync(f.configPath, "utf8");
    assert.throws(() => controller.previewConfig(request), /不支持 Fast/);
    assert.throws(() => controller.saveConfig(request), /不支持 Fast/);
    assert.equal(readFileSync(f.configPath, "utf8"), before);
    supportsFastMode = true;
    await controller.previewConfig(request);
    await controller.saveConfig(request);
    assert.equal(
      validateConfigText(readFileSync(f.configPath, "utf8"), f.configPath).runtime.fastMode,
      true,
    );
  } finally {
    f.close();
  }
});

test("UI preview/save resolve environment references and preserve the original YAML values", async () => {
  const env = {
    ROLL_P2_PROVIDER: "chatgpt",
    ROLL_P2_MODEL: "fixture",
    ROLL_P2_ACCOUNT: "account-a",
    ROLL_P2_EFFORT: "max",
  };
  const beforeEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    for (const mode of ["structured", "yaml"] as const) {
      const f = fixture();
      try {
        let lookups = 0;
        const controller = createRollUiRuntimeController({
          configPath: f.configPath,
          getChatGptModels: (accountId) => {
            assert.equal(accountId, "account-a");
            lookups += 1;
            return [
              { slug: "fixture", displayName: "fixture", reasoningEfforts: ["max", "xhigh"] },
            ];
          },
        });
        const draft = {
          ...f.initial,
          runtime: {
            provider: `\${ROLL_P2_PROVIDER}`,
            model: `\${ROLL_P2_MODEL}`,
            chatgptAccountId: `\${ROLL_P2_ACCOUNT}`,
            thinkingLevel: `\${ROLL_P2_EFFORT}`,
            compaction: { thinkingLevel: "xhigh" },
          },
        };
        const before = readFileSync(f.configPath, "utf8");
        const expectedRevision = f.snapshot().revision;
        const request =
          mode === "structured"
            ? { mode, persisted: draft, expectedRevision }
            : { mode, yaml: JSON.stringify(draft), expectedRevision };
        await controller.previewConfig(request);
        assert.equal(readFileSync(f.configPath, "utf8"), before);
        await controller.saveConfig(request);
        const saved = readFileSync(f.configPath, "utf8");
        for (const key of Object.keys(env)) assert.ok(saved.includes(`\${${key}}`));
        const effective = validateConfigText(saved, f.configPath);
        assert.equal(effective.runtime.thinkingLevel, "max");
        assert.equal(effective.runtime.compaction.thinkingLevel, "xhigh");
        assert.ok(lookups >= 2);
        process.env.ROLL_P2_EFFORT = "high";
        assert.throws(
          () => controller.previewConfig({ ...request, expectedRevision: f.snapshot().revision }),
          /不支持推理强度 "high"/,
        );
        assert.equal(readFileSync(f.configPath, "utf8"), saved);
        process.env.ROLL_P2_EFFORT = "max";
      } finally {
        f.close();
      }
    }
  } finally {
    for (const [key, value] of Object.entries(beforeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("UI checks the effective medium default and inherited compaction effort before writing", async () => {
  const f = fixture();
  try {
    const controller = createRollUiRuntimeController({
      configPath: f.configPath,
      getChatGptModels: () => [
        { slug: "fixture", displayName: "fixture", reasoningEfforts: ["low"] },
      ],
    });
    const before = readFileSync(f.configPath, "utf8");
    const request = {
      mode: "structured",
      persisted: f.initial,
      expectedRevision: f.snapshot().revision,
    } as const;
    for (const operation of ["previewConfig", "saveConfig"] as const) {
      assert.throws(
        () => controller[operation](request),
        (error: unknown) => {
          assert.ok(error instanceof ConfigApplicationValidationError);
          assert.deepEqual(
            error.issues.map(({ path }) => path),
            ["runtime.thinkingLevel", "runtime.compaction.thinkingLevel"],
          );
          assert.match(error.message, /medium/);
          return true;
        },
      );
      assert.equal(readFileSync(f.configPath, "utf8"), before);
    }
    const corrected = { ...f.initial, runtime: { ...f.initial.runtime, thinkingLevel: "low" } };
    await controller.saveConfig({ ...request, persisted: corrected });
    const effective = validateConfigText(readFileSync(f.configPath, "utf8"), f.configPath);
    assert.equal(effective.runtime.thinkingLevel, "low");
    assert.equal(effective.runtime.compaction.thinkingLevel, undefined);
    const invalidCompaction = {
      ...corrected,
      runtime: { ...corrected.runtime, compaction: { thinkingLevel: "max" } },
    };
    assert.throws(
      () => controller.previewConfig({ mode: "yaml", yaml: JSON.stringify(invalidCompaction) }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigApplicationValidationError);
        assert.deepEqual(
          error.issues.map(({ path }) => path),
          ["runtime.compaction.thinkingLevel"],
        );
        return true;
      },
    );
  } finally {
    f.close();
  }
});

test("UI uses the effective default provider and keeps unavailable capabilities unverified", async () => {
  const f = fixture();
  try {
    const draft = {
      ...f.initial,
      llm: { ...f.initial.llm, defaultProvider: "chatgpt" },
      runtime: { model: "fixture", thinkingLevel: "max" },
    };
    for (const models of [
      [],
      [{ slug: "fixture", displayName: "fixture" }],
      [{ slug: "another", displayName: "another", reasoningEfforts: ["low"] }],
    ]) {
      const controller = createRollUiRuntimeController({
        configPath: f.configPath,
        getChatGptModels: () => models,
      });
      await controller.saveConfig({
        mode: "structured",
        persisted: draft,
        expectedRevision: f.snapshot().revision,
      });
    }
    const controller = createRollUiRuntimeController({
      configPath: f.configPath,
      getChatGptModels: () => [
        { slug: "fixture", displayName: "fixture", reasoningEfforts: ["low"] },
      ],
    });
    assert.throws(
      () => controller.previewConfig({ mode: "structured", persisted: draft }),
      /不支持推理强度 "max"/,
    );
  } finally {
    f.close();
  }
});

test("API configuration validation stays offline and ordinary config writes keep their existing scope", async () => {
  const f = fixture();
  try {
    const controller = createRollUiRuntimeController({
      configPath: f.configPath,
      getChatGptModels: () => {
        throw new Error("unexpected subscription access");
      },
    });
    const draft = { ...f.initial, runtime: { provider: "openai", thinkingLevel: "high" } };
    await controller.saveConfig({
      mode: "structured",
      persisted: draft,
      expectedRevision: f.snapshot().revision,
    });
    const invalid = { ...draft, runtime: { ...draft.runtime, thinkingLevel: "max" } };
    assert.throws(
      () => controller.previewConfig({ mode: "structured", persisted: invalid }),
      /不支持推理强度 "max"/,
    );
    const service = new ConfigApplicationService({ configPath: f.configPath });
    assert.doesNotThrow(() => service.previewStructured(invalid));
  } finally {
    f.close();
  }
});
