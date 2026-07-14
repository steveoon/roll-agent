import { SECRET_SENTINEL } from "./types.ts";
import { getAtPath } from "./lib/config-value.ts";
import type { ConfigApplicationSnapshot, ConfigPath, EditorMode, JsonObject } from "./types.ts";

export const EDITOR_MODE_CHANGE_STRATEGIES = {
  noop: "noop",
  switchClean: "switch-clean",
  previewFormDraft: "preview-form-draft",
  blockYamlDraft: "block-yaml-draft",
} as const;

export type EditorModeChangeStrategy =
  (typeof EDITOR_MODE_CHANGE_STRATEGIES)[keyof typeof EDITOR_MODE_CHANGE_STRATEGIES];

export function isEditorDraftDirty(
  mode: EditorMode,
  persistedDraft: JsonObject,
  yamlDraft: string,
  persistedSnapshot: JsonObject,
  yamlSnapshot: string,
): boolean {
  return mode === "form"
    ? JSON.stringify(persistedDraft) !== JSON.stringify(persistedSnapshot)
    : yamlDraft !== yamlSnapshot;
}

export function planEditorModeChange(
  currentMode: EditorMode,
  nextMode: EditorMode,
  dirty: boolean,
): EditorModeChangeStrategy {
  if (currentMode === nextMode) return EDITOR_MODE_CHANGE_STRATEGIES.noop;
  if (!dirty) return EDITOR_MODE_CHANGE_STRATEGIES.switchClean;
  return currentMode === "yaml"
    ? EDITOR_MODE_CHANGE_STRATEGIES.blockYamlDraft
    : EDITOR_MODE_CHANGE_STRATEGIES.previewFormDraft;
}

export function isCurrentDraftGeneration(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}

export function resolveSecretInputValue(
  nextValue: string,
  canRestoreExistingSecret: boolean,
): string {
  return nextValue.length === 0 && canRestoreExistingSecret ? SECRET_SENTINEL : nextValue;
}

export function wouldSecretProjectionLoseDraft(
  persistedDraft: JsonObject,
  projectedSnapshot: ConfigApplicationSnapshot,
): boolean {
  return projectedSnapshot.configuredSecretPaths.some(
    (path) =>
      getAtPath(projectedSnapshot.persisted, path) === SECRET_SENTINEL &&
      getAtPath(persistedDraft, path) !== SECRET_SENTINEL,
  );
}

export function hasPathKeyedEntries(entries: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(entries).length > 0;
}

export function omitPathKeyedEntriesAtOrBelow<T>(
  entries: Readonly<Record<string, T>>,
  parentPath: ConfigPath,
): Readonly<Record<string, T>> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    const candidatePath = parseConfigPathKey(key);
    if (candidatePath === undefined || !isPathAtOrBelow(candidatePath, parentPath)) {
      next[key] = value;
    }
  }
  return next;
}

function parseConfigPathKey(value: string): ConfigPath | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((segment) => typeof segment === "string" || typeof segment === "number")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function isPathAtOrBelow(candidate: ConfigPath, parent: ConfigPath): boolean {
  return (
    candidate.length >= parent.length &&
    parent.every((segment, index) => candidate[index] === segment)
  );
}
