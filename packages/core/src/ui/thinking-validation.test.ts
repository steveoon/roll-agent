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

test("UI validates Gemini 4 Neon/Hydrogen vs Carbon/Argon capabilities including full resource paths", async () => {
  const f = fixture();
  try {
    const controller = createRollUiRuntimeController({
      configPath: f.configPath,
      getChatGptModels: () => {
        throw new Error("unexpected subscription access");
      },
    });
    const viaDefaultModel = {
      ...f.initial,
      llm: { defaultProvider: "google", defaultModel: "gemini-4-neon", providers: {} },
      runtime: { thinkingLevel: "xhigh", compaction: { thinkingLevel: "xhigh" } },
    };
    await controller.previewConfig({ mode: "structured", persisted: viaDefaultModel });
    await controller.saveConfig({
      mode: "structured",
      persisted: viaDefaultModel,
      expectedRevision: f.snapshot().revision,
    });
    const saved = validateConfigText(readFileSync(f.configPath, "utf8"), f.configPath);
    assert.equal(saved.runtime.thinkingLevel, "xhigh");
    assert.equal(saved.runtime.compaction.thinkingLevel, "xhigh");

    const carbonProjectNeon = {
      ...f.initial,
      llm: {
        defaultProvider: "google",
        defaultModel:
          "projects/gemini-4-carbon-prod/locations/global/publishers/google/models/gemini-4-neon",
        providers: {},
      },
      runtime: { thinkingLevel: "xhigh" },
    };
    await controller.previewConfig({ mode: "structured", persisted: carbonProjectNeon });

    for (const unsupported of ["off", "max"] as const) {
      const invalidChat = {
        ...viaDefaultModel,
        runtime: { provider: "google", model: "gemini-4-hydrogen", thinkingLevel: unsupported },
      };
      assert.throws(
        () => controller.previewConfig({ mode: "structured", persisted: invalidChat }),
        new RegExp(`不支持推理强度 "${unsupported}"`),
      );
      const invalidCompaction = {
        ...viaDefaultModel,
        runtime: {
          provider: "google",
          model: "gemini-4-neon",
          thinkingLevel: "xhigh",
          compaction: { thinkingLevel: unsupported },
        },
      };
      assert.throws(
        () => controller.previewConfig({ mode: "structured", persisted: invalidCompaction }),
        new RegExp(`不支持推理强度 "${unsupported}"`),
      );
    }

    for (const carbonModel of [
      "gemini-4-carbon",
      "gemini-4-argon",
      "models/gemini-4-carbon",
      "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-4-carbon",
    ]) {
      const validCarbon = {
        ...f.initial,
        llm: { defaultProvider: "google", defaultModel: carbonModel, providers: {} },
        runtime: { thinkingLevel: "high", compaction: { thinkingLevel: "low" } },
      };
      await controller.previewConfig({ mode: "structured", persisted: validCarbon });
      for (const unsupported of ["off", "xhigh", "max"] as const) {
        const invalidCarbon = {
          ...validCarbon,
          runtime: { thinkingLevel: unsupported },
        };
        assert.throws(
          () => controller.previewConfig({ mode: "structured", persisted: invalidCarbon }),
          new RegExp(`不支持推理强度 "${unsupported}"`),
        );
      }
    }

    const neonProjectLegacy = {
      ...f.initial,
      llm: {
        defaultProvider: "google",
        defaultModel:
          "projects/gemini-4-neon-prod/locations/global/publishers/google/models/gemini-2.5-flash",
        providers: {},
      },
      runtime: { thinkingLevel: "xhigh" },
    };
    assert.throws(
      () => controller.previewConfig({ mode: "structured", persisted: neonProjectLegacy }),
      /不支持推理强度 "xhigh"/,
    );
    await controller.previewConfig({
      mode: "structured",
      persisted: { ...neonProjectLegacy, runtime: { thinkingLevel: "off" } },
    });
  } finally {
    f.close();
  }
});

test("UI defers only unresolved identity placeholders across structured and YAML edits while preserving placeholders on save", async () => {
  const placeholderVar = "ROLL_T1_UNSET_GOOGLE_MODEL";
  const previousValue = process.env[placeholderVar];
  delete process.env[placeholderVar];

  try {
    for (const mode of ["structured", "yaml"] as const) {
      const f = fixture();
      try {
        const controller = createRollUiRuntimeController({
          configPath: f.configPath,
          getChatGptModels: () => [
            { slug: "no-fast", displayName: "No Fast", supportsFastMode: false },
          ],
        });

        const baseDraft = {
          ...f.initial,
          llm: {
            defaultProvider: "google",
            defaultModel: `\${${placeholderVar}}`,
            providers: {},
          },
          ask: { confirmThreshold: 0.7 },
          runtime: { thinkingLevel: "xhigh", compaction: { thinkingLevel: "xhigh" } },
        };
        type Revision = ReturnType<typeof f.snapshot>["revision"];
        const toPreviewRequest = (draft: Record<string, unknown>) =>
          mode === "structured"
            ? { mode, persisted: draft }
            : { mode, yaml: JSON.stringify(draft) };
        const toSaveRequest = (draft: Record<string, unknown>, expectedRevision: Revision) =>
          mode === "structured"
            ? { mode, persisted: draft, expectedRevision }
            : { mode, yaml: JSON.stringify(draft), expectedRevision };

        // 1. Unset placeholder allows editing unrelated fields (e.g. ask.confirmThreshold) and preserves placeholder.
        await controller.previewConfig(toPreviewRequest(baseDraft));
        await controller.saveConfig(toSaveRequest(baseDraft, f.snapshot().revision));
        const savedUnset = readFileSync(f.configPath, "utf8");
        assert.ok(
          savedUnset.includes(`\${${placeholderVar}}`),
          "saved config must keep placeholder",
        );
        assert.equal(validateConfigText(savedUnset, f.configPath).ask.confirmThreshold, 0.7);

        // 2. Resolved to Neon -> xhigh succeeds and save still preserves raw placeholder; off fails.
        process.env[placeholderVar] = "gemini-4-neon";
        const updatedUnrelated = { ...baseDraft, ask: { confirmThreshold: 0.8 } };
        await controller.previewConfig(toPreviewRequest(updatedUnrelated));
        await controller.saveConfig(toSaveRequest(updatedUnrelated, f.snapshot().revision));
        const savedNeon = readFileSync(f.configPath, "utf8");
        assert.ok(savedNeon.includes(`\${${placeholderVar}}`));
        assert.equal(validateConfigText(savedNeon, f.configPath).ask.confirmThreshold, 0.8);
        assert.throws(
          () =>
            controller.previewConfig(
              toPreviewRequest({ ...baseDraft, runtime: { thinkingLevel: "off" } }),
            ),
          /不支持推理强度 "off"/,
        );

        // 3. Resolved to Carbon -> xhigh and off are strictly rejected; high succeeds.
        process.env[placeholderVar] = "gemini-4-carbon";
        assert.throws(
          () => controller.previewConfig(toPreviewRequest(baseDraft)),
          /不支持推理强度 "xhigh"/,
        );
        await controller.previewConfig(
          toPreviewRequest({ ...baseDraft, runtime: { thinkingLevel: "high" } }),
        );

        delete process.env[placeholderVar];

        // 4. Schema validation, model-independent provider limits, known terminal segment, and Fast remain enforced.
        assert.throws(
          () =>
            controller.previewConfig(
              toPreviewRequest({ ...baseDraft, runtime: { thinkingLevel: "not-a-level" } }),
            ),
          ConfigApplicationValidationError,
        );
        assert.throws(
          () =>
            controller.previewConfig(
              toPreviewRequest({
                ...baseDraft,
                llm: {
                  defaultProvider: "openai",
                  defaultModel: `\${${placeholderVar}}`,
                  providers: {},
                },
              }),
            ),
          /不支持推理强度 "xhigh"/,
        );
        assert.throws(
          () =>
            controller.previewConfig(
              toPreviewRequest({
                ...baseDraft,
                llm: {
                  defaultProvider: "google",
                  defaultModel: `projects/\${${placeholderVar}}/locations/global/publishers/google/models/gemini-4-carbon`,
                  providers: {},
                },
              }),
            ),
          /不支持推理强度 "xhigh"/,
        );
        assert.throws(
          () =>
            controller.previewConfig(
              toPreviewRequest({
                ...f.initial,
                runtime: { provider: "chatgpt", model: "no-fast", fastMode: true },
              }),
            ),
          /不支持 Fast/,
        );
      } finally {
        delete process.env[placeholderVar];
        f.close();
      }
    }
  } finally {
    if (previousValue === undefined) delete process.env[placeholderVar];
    else process.env[placeholderVar] = previousValue;
  }
});
