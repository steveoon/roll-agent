import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDITOR_MODE_CHANGE_STRATEGIES,
  isCurrentDraftGeneration,
  isEditorDraftDirty,
  hasPathKeyedEntries,
  omitPathKeyedEntriesAtOrBelow,
  planEditorModeChange,
  resolveSecretInputValue,
  wouldSecretProjectionLoseDraft,
} from "./app-state.ts";
import { SECRET_SENTINEL } from "./types.ts";

describe("Roll UI draft state", () => {
  it("keeps formatting-only YAML edits dirty and blocks a lossy switch to form mode", () => {
    const persisted = { runtime: { turnTimeoutMs: 300_000 } };
    const savedYaml = "runtime:\n  turn-timeout-ms: 300000\n";
    const draftYaml = "# keep this operator note\nruntime:\n  turn-timeout-ms: 300000\n";

    const dirty = isEditorDraftDirty("yaml", persisted, draftYaml, persisted, savedYaml);

    assert.equal(dirty, true);
    assert.equal(
      planEditorModeChange("yaml", "form", dirty),
      EDITOR_MODE_CHANGE_STRATEGIES.blockYamlDraft,
    );
  });

  it("previews dirty form drafts before switching and directly switches clean drafts", () => {
    assert.equal(
      planEditorModeChange("form", "yaml", true),
      EDITOR_MODE_CHANGE_STRATEGIES.previewFormDraft,
    );
    assert.equal(
      planEditorModeChange("form", "yaml", false),
      EDITOR_MODE_CHANGE_STRATEGIES.switchClean,
    );
    assert.equal(planEditorModeChange("form", "form", true), EDITOR_MODE_CHANGE_STRATEGIES.noop);
  });

  it("recognizes responses that belong to an older draft generation", () => {
    assert.equal(isCurrentDraftGeneration(7, 7), true);
    assert.equal(isCurrentDraftGeneration(7, 8), false);
  });
});

describe("Roll UI path-keyed draft state", () => {
  it("treats an invalid local draft as unsaved state", () => {
    assert.equal(hasPathKeyedEntries({}), false);
    assert.equal(hasPathKeyedEntries({ '["runtime","futureJson"]': "{" }), true);
  });

  it("clears invalid drafts at or below a deleted config path", () => {
    const drafts = {
      '["browser","instances","work","futureJson"]': "{",
      '["browser","defaultInstance"]': '"work"',
    };
    assert.deepEqual(omitPathKeyedEntriesAtOrBelow(drafts, ["browser", "instances", "work"]), {
      '["browser","defaultInstance"]': '"work"',
    });
  });

  it("clears the whole array draft namespace when removing an indexed item", () => {
    const drafts = {
      '["skills","dirs",0]': '"first"',
      '["skills","dirs",1]': "{",
      '["runtime","futureJson"]': "{",
    };

    assert.deepEqual(omitPathKeyedEntriesAtOrBelow(drafts, ["skills", "dirs"]), {
      '["runtime","futureJson"]': "{",
    });
  });
});

describe("Roll UI secret replacement state", () => {
  it("restores the keep-existing sentinel when a configured secret replacement is cleared", () => {
    assert.equal(resolveSecretInputValue("replacement", true), "replacement");
    assert.equal(resolveSecretInputValue("", true), SECRET_SENTINEL);
  });

  it("keeps an empty value empty when no existing secret can be restored", () => {
    assert.equal(resolveSecretInputValue("", false), "");
  });

  it("detects when a sanitized preview would discard a new or replacement secret draft", () => {
    const projectedSnapshot = {
      configPath: "/tmp/roll.config.yaml",
      existed: true,
      revision: "rev-1",
      persisted: {
        llm: { providers: { openai: { apiKey: SECRET_SENTINEL } } },
        agents: { env: { notifier: { WEBHOOK: SECRET_SENTINEL } } },
      },
      yaml: "",
      configuredSecretPaths: [
        ["llm", "providers", "openai", "apiKey"],
        ["agents", "env", "notifier", "WEBHOOK"],
      ],
    } as const;

    assert.equal(
      wouldSecretProjectionLoseDraft(
        {
          llm: { providers: { openai: { apiKey: "replacement" } } },
          agents: { env: { notifier: { WEBHOOK: SECRET_SENTINEL } } },
        },
        projectedSnapshot,
      ),
      true,
    );
    assert.equal(
      wouldSecretProjectionLoseDraft(projectedSnapshot.persisted, projectedSnapshot),
      false,
    );
  });

  it("allows an environment placeholder that remains visible in the projected snapshot", () => {
    const envReference = "$" + "{OPENAI_API_KEY}";
    const projectedSnapshot = {
      configPath: "/tmp/roll.config.yaml",
      existed: true,
      revision: "rev-1",
      persisted: { llm: { providers: { openai: { apiKey: envReference } } } },
      yaml: "",
      configuredSecretPaths: [["llm", "providers", "openai", "apiKey"]],
    } as const;

    assert.equal(
      wouldSecretProjectionLoseDraft(projectedSnapshot.persisted, projectedSnapshot),
      false,
    );
  });
});
