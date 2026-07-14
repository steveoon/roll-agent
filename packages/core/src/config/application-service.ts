import { homedir } from "node:os";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG } from "./defaults.ts";
import {
  ConfigRevisionConflictError,
  YamlConfigDocumentStore,
  applyPatchesToYamlText,
  type ConfigDocumentPreview,
  type ConfigDocumentWriteResult,
  type ConfigPatch,
  type ConfigPath,
  type ConfigRevision,
} from "./document-store.ts";
import {
  CONFIG_KEY_CODEC,
  decodeFromYaml,
  encodePathToYaml,
  encodeToYaml,
  kebabToCamel,
  type KeyCodecNode,
} from "./key-codec.ts";
import {
  parseConfigDocument,
  resolveConfigPath,
  validateConfigText,
  type LoadConfigOptions,
} from "./loader.ts";
import { detectKnownConfigMigrations, formatConfigMigrationError } from "./migration.ts";
import { isRollConfigSecretPath, isSecretConfigValue } from "./secret-policy.ts";

export const CONFIG_UI_SECRET_SENTINEL = "__ROLL_UI_KEEP_EXISTING_SECRET__" as const;

export const CONFIG_ACTIVATION_KINDS = [
  "next-command",
  "next-chat",
  "restart-agent",
  "manual",
] as const;
export type ConfigActivationKind = (typeof CONFIG_ACTIVATION_KINDS)[number];

export interface ConfigActivationEffect {
  readonly kind: ConfigActivationKind;
  readonly paths: readonly ConfigPath[];
  readonly title: string;
  readonly description: string;
  readonly agentName?: string;
  readonly requiresConfirmation: boolean;
}

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ConfigDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
}

export interface ConfigApplicationSnapshot {
  readonly configPath: string;
  readonly existed: boolean;
  readonly revision: ConfigRevision;
  readonly persisted: Readonly<Record<string, unknown>>;
  readonly yaml: string;
  readonly configuredSecretPaths: readonly ConfigPath[];
}

export interface ConfigApplicationPreview {
  readonly snapshot: ConfigApplicationSnapshot;
  readonly changed: boolean;
  readonly changedPaths: readonly ConfigPath[];
  readonly effects: readonly ConfigActivationEffect[];
  readonly diff: readonly ConfigDiffLine[];
}

export interface ConfigApplicationSaveResult extends ConfigApplicationPreview {
  readonly backupPath?: string;
}

export interface ConfigApplicationRecoverySaveResult {
  readonly snapshot: ConfigApplicationSnapshot;
  readonly changed: boolean;
  readonly backupPath?: string;
}

export interface ConfigApplicationServiceOptions extends LoadConfigOptions {
  /** Extra Agent env names declared as secret in their env.yaml contract. */
  readonly secretEnvNames?: readonly string[];
  /** Exact Agent env visibility derived from registered env.yaml declarations. */
  readonly agentEnvFields?: readonly ConfigAgentEnvFieldPolicy[];
  /** Fail closed for undeclared Agent env fields, including newly added candidate values. */
  readonly redactUnknownAgentEnv?: boolean;
}

export interface ConfigAgentEnvFieldPolicy {
  readonly agentName: string;
  readonly name: string;
  readonly secret: boolean;
}

export class ConfigApplicationValidationError extends Error {
  readonly code = "config_validation_failed" as const;
  readonly issues: readonly ConfigValidationIssue[];

  constructor(error: unknown) {
    const source = error instanceof Error ? error : new Error(String(error));
    super(source.message, { cause: source });
    this.name = "ConfigApplicationValidationError";
    this.issues = parseValidationIssues(source.message);
  }
}

interface PreparedApplicationPreview {
  readonly publicPreview: ConfigApplicationPreview;
  readonly documentPreview: ConfigDocumentPreview;
}

export class ConfigApplicationService {
  readonly configPath: string;
  readonly store: YamlConfigDocumentStore;
  private readonly isSecretPath: (path: ConfigPath) => boolean;

  constructor(options: ConfigApplicationServiceOptions = {}) {
    this.configPath = resolveConfigPath(options) ?? resolve(homedir(), "roll.config.yaml");
    this.store = new YamlConfigDocumentStore(this.configPath, buildBaseConfigYaml());
    const secretEnvNames = new Set(options.secretEnvNames ?? []);
    const agentEnvFields = new Map(
      (options.agentEnvFields ?? []).map((field) => [
        agentEnvFieldKey(field.agentName, field.name),
        field.secret,
      ]),
    );
    this.isSecretPath = (path) =>
      isSecretConfigPath(
        path,
        secretEnvNames,
        agentEnvFields,
        options.redactUnknownAgentEnv ?? false,
      );
  }

  read(): ConfigApplicationSnapshot {
    const snapshot = this.store.read();
    validateRawConfig(snapshot.raw, snapshot.configPath);
    return createPublicSnapshot(snapshot, this.isSecretPath);
  }

  /** Load syntactically valid persisted data so a focused CLI setup can repair schema errors. */
  readForRepair(): ConfigApplicationSnapshot {
    const snapshot = this.store.read();
    const persisted = parseConfigDocument(snapshot.raw, snapshot.configPath);
    const migrationReport = detectKnownConfigMigrations(persisted);
    if (migrationReport.needsMigration) {
      throw new ConfigApplicationValidationError(
        new Error(formatConfigMigrationError(snapshot.configPath, migrationReport)),
      );
    }
    return createPublicSnapshot(snapshot, this.isSecretPath);
  }

  previewPatches(
    patches: readonly ConfigPatch[],
    expectedRevision?: ConfigRevision,
  ): ConfigApplicationPreview {
    return this.preparePatches(patches, expectedRevision).publicPreview;
  }

  savePatches(
    patches: readonly ConfigPatch[],
    expectedRevision?: ConfigRevision,
  ): ConfigApplicationSaveResult {
    return this.commitPrepared(this.preparePatches(patches, expectedRevision));
  }

  previewStructured(
    persisted: unknown,
    expectedRevision?: ConfigRevision,
  ): ConfigApplicationPreview {
    return this.prepareStructured(persisted, expectedRevision).publicPreview;
  }

  saveStructured(
    persisted: unknown,
    expectedRevision?: ConfigRevision,
  ): ConfigApplicationSaveResult {
    return this.commitPrepared(this.prepareStructured(persisted, expectedRevision));
  }

  previewYaml(yaml: string, expectedRevision?: ConfigRevision): ConfigApplicationPreview {
    return this.prepareYaml(yaml, expectedRevision).publicPreview;
  }

  saveYaml(yaml: string, expectedRevision?: ConfigRevision): ConfigApplicationSaveResult {
    return this.commitPrepared(this.prepareYaml(yaml, expectedRevision));
  }

  /**
   * Recover an invalid existing file during an explicitly confirmed `roll config init` overwrite.
   * The generated candidate is fully validated, but the old document is never parsed or returned
   * to a browser. UI and ordinary CLI edits must continue to use preview/save methods above.
   */
  replaceYamlForInit(
    yaml: string,
    expectedRevision: ConfigRevision,
  ): ConfigApplicationRecoverySaveResult {
    validateRawConfig(yaml, this.configPath);
    const writeResult = this.store.replaceRawForRecovery(yaml, expectedRevision);
    const snapshot = createPublicSnapshot(writeResult, this.isSecretPath);
    return {
      snapshot,
      changed: writeResult.changed,
      ...(writeResult.backupPath !== undefined ? { backupPath: writeResult.backupPath } : {}),
    };
  }

  private preparePatches(
    patches: readonly ConfigPatch[],
    expectedRevision?: ConfigRevision,
  ): PreparedApplicationPreview {
    const encodedPatches = patches.map(encodeConfigPatch);
    const documentPreview = this.store.previewPatches(encodedPatches, expectedRevision);
    return this.prepareDocumentPreview(documentPreview);
  }

  private prepareStructured(
    persisted: unknown,
    expectedRevision?: ConfigRevision,
  ): PreparedApplicationPreview {
    if (!isRecord(persisted)) {
      throw new ConfigApplicationValidationError(
        new Error("配置内容必须是一个 JSON/YAML object。"),
      );
    }
    const current = this.store.read();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new ConfigRevisionConflictError(expectedRevision, current.revision);
    }
    const currentCanonical = decodePersistedConfig(current.persisted);
    const restored = restoreSecretSentinels(persisted, currentCanonical, [], this.isSecretPath);
    const encoded = encodeToYaml(restored);
    if (!isRecord(encoded)) {
      throw new ConfigApplicationValidationError(new Error("编码后的配置必须是 object。"));
    }
    const documentPreview = this.store.previewObject(encoded, current.revision);
    return this.prepareDocumentPreview(documentPreview);
  }

  private prepareYaml(yaml: string, expectedRevision?: ConfigRevision): PreparedApplicationPreview {
    const current = this.store.read();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new ConfigRevisionConflictError(expectedRevision, current.revision);
    }

    let candidateRaw = yaml;
    let candidatePersisted: Readonly<Record<string, unknown>>;
    try {
      candidatePersisted = parseConfigDocument(candidateRaw, this.configPath);
    } catch (error) {
      throw new ConfigApplicationValidationError(error);
    }
    const currentCanonical = decodePersistedConfig(current.persisted);
    const secretRestorePatches: ConfigPatch[] = [];
    collectYamlSecretRestorePatches(
      candidatePersisted,
      currentCanonical,
      [],
      [],
      secretRestorePatches,
      this.isSecretPath,
      CONFIG_KEY_CODEC,
    );
    if (secretRestorePatches.length > 0) {
      candidateRaw = applyPatchesToYamlText(candidateRaw, this.configPath, secretRestorePatches);
    }

    let documentPreview: ConfigDocumentPreview;
    try {
      documentPreview = this.store.previewRaw(candidateRaw, current.revision);
    } catch (error) {
      throw new ConfigApplicationValidationError(error);
    }
    return this.prepareDocumentPreview(documentPreview);
  }

  private prepareDocumentPreview(
    documentPreview: ConfigDocumentPreview,
  ): PreparedApplicationPreview {
    validateRawConfig(documentPreview.raw, this.configPath);
    const previousCanonical = decodePersistedConfig(
      parseConfigDocument(documentPreview.previousRaw, this.configPath),
    );
    const nextCanonical = decodePersistedConfig(documentPreview.persisted);
    const changedPaths = collectChangedPaths(previousCanonical, nextCanonical);
    const publicSnapshot = createPublicSnapshot(documentPreview, this.isSecretPath);
    const previousPersisted = parseConfigDocument(documentPreview.previousRaw, this.configPath);
    const previousPublicSnapshot = createPublicSnapshot(
      {
        configPath: documentPreview.configPath,
        existed: documentPreview.existed,
        raw: documentPreview.previousRaw,
        revision: documentPreview.previousRevision,
        persisted: previousPersisted,
      },
      this.isSecretPath,
    );
    return {
      documentPreview,
      publicPreview: {
        snapshot: publicSnapshot,
        changed: documentPreview.changed,
        changedPaths,
        effects: planConfigActivation(changedPaths),
        diff: buildLineDiff(previousPublicSnapshot.yaml, publicSnapshot.yaml),
      },
    };
  }

  private commitPrepared(prepared: PreparedApplicationPreview): ConfigApplicationSaveResult {
    const writeResult = this.store.commit(prepared.documentPreview, { backup: true });
    const snapshot = createPublicSnapshot(writeResult, this.isSecretPath);
    return {
      ...prepared.publicPreview,
      snapshot,
      ...(writeResult.backupPath !== undefined ? { backupPath: writeResult.backupPath } : {}),
    };
  }
}

export function planConfigActivation(
  changedPaths: readonly ConfigPath[],
): readonly ConfigActivationEffect[] {
  const grouped = new Map<
    string,
    Omit<ConfigActivationEffect, "paths"> & { paths: ConfigPath[] }
  >();

  for (const path of changedPaths) {
    const descriptor = describeActivation(path);
    const key = `${descriptor.kind}:${descriptor.agentName ?? ""}:${descriptor.title}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      existing.paths.push(path);
    } else {
      grouped.set(key, { ...descriptor, paths: [path] });
    }
  }

  return [...grouped.values()].map((effect) => ({
    ...effect,
    paths: effect.paths,
  }));
}

export function createConfigPatches(
  before: unknown,
  after: unknown,
  path: ConfigPath = [],
): readonly ConfigPatch[] {
  if (isRecord(before) && isRecord(after)) {
    const patches: ConfigPatch[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!(key in after)) {
        patches.push({ op: "delete", path: [...path, key] });
        continue;
      }
      if (!(key in before)) {
        patches.push({ op: "set", path: [...path, key], value: after[key] });
        continue;
      }
      patches.push(...createConfigPatches(before[key], after[key], [...path, key]));
    }
    return patches;
  }
  if (deepEqual(before, after)) {
    return [];
  }
  if (path.length === 0) {
    throw new ConfigApplicationValidationError(new Error("配置根节点必须保持为 object。"));
  }
  return [{ op: "set", path, value: after }];
}

function describeActivation(path: ConfigPath): Omit<ConfigActivationEffect, "paths"> {
  const [section, second, agentName] = path;
  if (section === "agents" && second === "dataDir") {
    return {
      kind: "manual",
      title: "Agent 数据目录需要人工迁移",
      description: "保存不会搬迁旧 PID、日志或注册数据；请先停止 Agent，再人工迁移目录。",
      requiresConfirmation: true,
    };
  }
  if (section === "agents" && second === "env" && typeof agentName === "string") {
    return {
      kind: "restart-agent",
      title: `重启 ${agentName}`,
      description: "运行中的 core-managed Agent 需要重启；已停止的 Agent 保持停止。",
      agentName,
      requiresConfirmation: true,
    };
  }
  if (section === "browser") {
    return {
      kind: "restart-agent",
      title: "重启 browser-use-agent",
      description:
        "浏览器实例声明在 Agent 启动时注入；重启 Agent 后 Chrome 仍会在首次工具调用时懒启动。",
      agentName: "browser-use-agent",
      requiresConfirmation: true,
    };
  }
  if (section === "runtime" || section === "skills") {
    return {
      kind: "next-chat",
      title: "新会话生效",
      description: "当前 roll chat 会话保持原配置，新会话会重新加载。",
      requiresConfirmation: false,
    };
  }
  return {
    kind: "next-command",
    title: "后续命令生效",
    description: "后续 Roll 命令会重新加载该配置。",
    requiresConfirmation: false,
  };
}

function createPublicSnapshot(
  snapshot: Pick<
    ConfigDocumentWriteResult,
    "configPath" | "existed" | "raw" | "revision" | "persisted"
  >,
  isSecretPath: (path: ConfigPath) => boolean,
): ConfigApplicationSnapshot {
  const canonical = decodePersistedConfig(snapshot.persisted);
  const configuredSecretLocations = collectConfiguredSecretLocations(
    snapshot.persisted,
    [],
    [],
    isSecretPath,
    CONFIG_KEY_CODEC,
  );
  const configuredSecretPaths = configuredSecretLocations.map((location) => location.path);
  const configuredSecretPathKeys = new Set(configuredSecretPaths.map(configPathKey));
  const sanitizedPersisted = sanitizePersisted(canonical, [], configuredSecretPathKeys);
  if (!isRecord(sanitizedPersisted)) {
    throw new ConfigApplicationValidationError(new Error("脱敏后的配置必须是 object。"));
  }
  const secretPatches: ConfigPatch[] = configuredSecretLocations
    .filter((location) => {
      const value = getAtPath(canonical, location.path);
      return !(typeof value === "string" && isCompleteEnvPlaceholder(value));
    })
    .map((location) => ({
      op: "set" as const,
      path: location.persistedPath,
      value: CONFIG_UI_SECRET_SENTINEL,
    }));
  const sanitizedYaml =
    secretPatches.length === 0
      ? snapshot.raw
      : applyPatchesToYamlText(snapshot.raw, snapshot.configPath, secretPatches);

  return {
    configPath: snapshot.configPath,
    existed: snapshot.existed,
    revision: snapshot.revision,
    persisted: sanitizedPersisted,
    yaml: sanitizedYaml,
    configuredSecretPaths,
  };
}

function validateRawConfig(raw: string, configPath: string): void {
  try {
    validateConfigText(raw, configPath);
  } catch (error) {
    throw new ConfigApplicationValidationError(error);
  }
}

function decodePersistedConfig(
  persisted: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const decoded = decodeFromYaml(persisted);
  if (!isRecord(decoded)) {
    throw new ConfigApplicationValidationError(new Error("持久化配置必须是 object。"));
  }
  return decoded;
}

function encodeConfigPatch(patch: ConfigPatch): ConfigPatch {
  const path = encodeConfigPath(patch.path);
  return patch.op === "set"
    ? { op: "set", path, value: encodePatchValue(patch.value, patch.path) }
    : { op: "delete", path };
}

function encodeConfigPath(path: ConfigPath): ConfigPath {
  const encodedStrings = encodePathToYaml(path.map(String));
  return encodedStrings.map((segment, index) =>
    typeof path[index] === "number" ? path[index] : segment,
  );
}

function encodePatchValue(value: unknown, path: ConfigPath): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  const wrapped = setAtPath({}, path, value);
  const encoded = encodeToYaml(wrapped);
  if (!isRecord(encoded)) {
    return value;
  }
  return getAtPath(encoded, encodeConfigPath(path));
}

function setAtPath(
  root: Record<string, unknown>,
  path: ConfigPath,
  value: unknown,
): Record<string, unknown> {
  let current = root;
  for (const [index, segment] of path.entries()) {
    const key = String(segment);
    if (index === path.length - 1) {
      current[key] = value;
      break;
    }
    const child: Record<string, unknown> = {};
    current[key] = child;
    current = child;
  }
  return root;
}

function collectChangedPaths(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  path: ConfigPath = [],
): readonly ConfigPath[] {
  const result: ConfigPath[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const previousValue = before[key];
    const nextValue = after[key];
    const nextPath = [...path, key];
    if (isRecord(previousValue) || isRecord(nextValue)) {
      result.push(
        ...collectChangedPaths(
          isRecord(previousValue) ? previousValue : {},
          isRecord(nextValue) ? nextValue : {},
          nextPath,
        ),
      );
      continue;
    }
    if (!deepEqual(previousValue, nextValue)) {
      result.push(nextPath);
    }
  }
  return result;
}

interface ConfiguredSecretLocation {
  readonly path: ConfigPath;
  readonly persistedPath: ConfigPath;
}

function collectConfiguredSecretLocations(
  value: unknown,
  path: ConfigPath,
  persistedPath: ConfigPath,
  isSecretPath: (path: ConfigPath) => boolean,
  codecNode: KeyCodecNode | undefined,
): readonly ConfiguredSecretLocation[] {
  const result: ConfiguredSecretLocation[] = [];
  if (Array.isArray(value)) {
    const itemNode = codecNode?.kind === "array" ? codecNode.item : codecNode;
    value.forEach((child, index) => {
      const nextPath = [...path, index];
      const nextPersistedPath = [...persistedPath, index];
      const canonicalChild = decodePersistedValue(child, itemNode);
      if (isSecretConfigValue(nextPath, canonicalChild, isSecretPath)) {
        result.push({ path: nextPath, persistedPath: nextPersistedPath });
      } else if (Array.isArray(child) || isRecord(child)) {
        result.push(
          ...collectConfiguredSecretLocations(
            child,
            nextPath,
            nextPersistedPath,
            isSecretPath,
            itemNode,
          ),
        );
      }
    });
    return result;
  }
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const decoded = decodePersistedChild(key, child, codecNode);
    const nextPath = [...path, decoded.key];
    const nextPersistedPath = [...persistedPath, key];
    if (isSecretConfigValue(nextPath, decoded.value, isSecretPath)) {
      result.push({ path: nextPath, persistedPath: nextPersistedPath });
    } else if (Array.isArray(child) || isRecord(child)) {
      result.push(
        ...collectConfiguredSecretLocations(
          child,
          nextPath,
          nextPersistedPath,
          isSecretPath,
          decoded.node,
        ),
      );
    }
  }
  return result;
}

function sanitizePersisted(
  value: unknown,
  path: ConfigPath,
  configuredSecretPathKeys: ReadonlySet<string>,
): unknown {
  if (configuredSecretPathKeys.has(configPathKey(path))) {
    return typeof value === "string" && isCompleteEnvPlaceholder(value)
      ? value
      : CONFIG_UI_SECRET_SENTINEL;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      sanitizePersisted(child, [...path, index], configuredSecretPathKeys),
    );
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sanitizePersisted(child, [...path, key], configuredSecretPathKeys),
    ]),
  );
}

function restoreSecretSentinels(
  value: unknown,
  current: unknown,
  path: ConfigPath,
  isSecretPath: (path: ConfigPath) => boolean,
): unknown {
  if (value === CONFIG_UI_SECRET_SENTINEL) {
    assertRestorableSecret(current, path, isSecretPath);
    return current;
  }
  if (Array.isArray(value)) {
    const currentArray = Array.isArray(current) ? current : [];
    return value.map((child, index) =>
      restoreSecretSentinels(child, currentArray[index], [...path, index], isSecretPath),
    );
  }
  if (!isRecord(value)) {
    return value;
  }
  const currentRecord = isRecord(current) ? current : {};
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      restoreSecretSentinels(child, currentRecord[key], [...path, key], isSecretPath),
    ]),
  );
}

function collectYamlSecretRestorePatches(
  candidate: unknown,
  currentCanonical: unknown,
  path: ConfigPath,
  persistedPath: ConfigPath,
  patches: ConfigPatch[],
  isSecretPath: (path: ConfigPath) => boolean,
  codecNode: KeyCodecNode | undefined,
): void {
  if (Array.isArray(candidate)) {
    const itemNode = codecNode?.kind === "array" ? codecNode.item : codecNode;
    candidate.forEach((child, index) => {
      const nextPath = [...path, index];
      const nextPersistedPath = [...persistedPath, index];
      const current = getAtPath(currentCanonical, nextPath);
      if (child === CONFIG_UI_SECRET_SENTINEL) {
        assertRestorableSecret(current, nextPath, isSecretPath);
        patches.push({ op: "set", path: nextPersistedPath, value: current });
        return;
      }
      collectYamlSecretRestorePatches(
        child,
        currentCanonical,
        nextPath,
        nextPersistedPath,
        patches,
        isSecretPath,
        itemNode,
      );
    });
    return;
  }
  if (!isRecord(candidate)) {
    return;
  }
  for (const [key, child] of Object.entries(candidate)) {
    const decoded = decodePersistedChild(key, child, codecNode);
    const nextPath = [...path, decoded.key];
    const nextPersistedPath = [...persistedPath, key];
    const current = getAtPath(currentCanonical, nextPath);
    if (child === CONFIG_UI_SECRET_SENTINEL) {
      assertRestorableSecret(current, nextPath, isSecretPath);
      patches.push({ op: "set", path: nextPersistedPath, value: current });
      continue;
    }
    collectYamlSecretRestorePatches(
      child,
      currentCanonical,
      nextPath,
      nextPersistedPath,
      patches,
      isSecretPath,
      decoded.node,
    );
  }
}

function decodePersistedChild(
  key: string,
  value: unknown,
  codecNode: KeyCodecNode | undefined,
): { readonly key: string; readonly value: unknown; readonly node: KeyCodecNode | undefined } {
  if (codecNode?.kind === "object") {
    const canonicalKey = kebabToCamel(key);
    const childNode = codecNode.fields[canonicalKey];
    return {
      key: canonicalKey,
      value: decodePersistedValue(value, childNode),
      node: childNode,
    };
  }
  if (codecNode?.kind === "record") {
    return {
      key,
      value: decodePersistedValue(value, codecNode.value),
      node: codecNode.value,
    };
  }
  return { key, value, node: undefined };
}

function decodePersistedValue(value: unknown, codecNode: KeyCodecNode | undefined): unknown {
  return codecNode === undefined || codecNode.kind === "leaf"
    ? value
    : decodeFromYaml(value, codecNode);
}

function assertRestorableSecret(
  value: unknown,
  path: ConfigPath,
  isSecretPath: (path: ConfigPath) => boolean,
): void {
  if (
    value === undefined ||
    value === CONFIG_UI_SECRET_SENTINEL ||
    !isSecretConfigValue(path, value, isSecretPath)
  ) {
    throw new ConfigApplicationValidationError(
      new Error(`无法在原路径恢复敏感配置: ${formatConfigPath(path)}`),
    );
  }
}

function isSecretConfigPath(
  path: ConfigPath,
  explicitSecretEnvNames: ReadonlySet<string> = new Set(),
  agentEnvFields: ReadonlyMap<string, boolean> = new Map(),
  redactUnknownAgentEnv = false,
): boolean {
  if (isRollConfigSecretPath(path)) {
    return true;
  }
  if (path.length === 4 && path[0] === "agents" && path[1] === "env") {
    const agentName = path[2];
    const envName = path[3];
    if (typeof agentName !== "string" || typeof envName !== "string") return false;
    const fieldKey = agentEnvFieldKey(agentName, envName);
    if (agentEnvFields.has(fieldKey)) return agentEnvFields.get(fieldKey) === true;
    if (explicitSecretEnvNames.has(envName) || redactUnknownAgentEnv) return true;
    return (
      /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY)(?:_|$)/u.test(envName) ||
      envName.endsWith("_WEBHOOK")
    );
  }
  return false;
}

function agentEnvFieldKey(agentName: string, envName: string): string {
  return `${agentName}\u0000${envName}`;
}

function isCompleteEnvPlaceholder(value: string): boolean {
  return /^\$\{[^{}]+\}$/u.test(value);
}

function configPathKey(path: ConfigPath): string {
  return JSON.stringify(path);
}

function getAtPath(value: unknown, path: ConfigPath): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[String(segment)];
  }
  return current;
}

function buildLineDiff(before: string, after: string): readonly ConfigDiffLine[] {
  if (before === after) {
    return before.split("\n").map((text) => ({ kind: "context" as const, text }));
  }
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < beforeLines.length - prefixLength &&
    suffixLength < afterLines.length - prefixLength &&
    beforeLines[beforeLines.length - suffixLength - 1] ===
      afterLines[afterLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const prefix = beforeLines
    .slice(0, prefixLength)
    .map((text) => ({ kind: "context" as const, text }));
  const removed = beforeLines
    .slice(prefixLength, beforeLines.length - suffixLength)
    .map((text) => ({ kind: "remove" as const, text }));
  const added = afterLines
    .slice(prefixLength, afterLines.length - suffixLength)
    .map((text) => ({ kind: "add" as const, text }));
  const suffix = beforeLines
    .slice(beforeLines.length - suffixLength)
    .map((text) => ({ kind: "context" as const, text }));
  return [...prefix, ...removed, ...added, ...suffix];
}

function buildBaseConfigYaml(): string {
  const baseConfig = {
    llm: DEFAULT_CONFIG.llm,
    ask: DEFAULT_CONFIG.ask,
    agents: DEFAULT_CONFIG.agents,
  };
  return stringifyYaml(encodeToYaml(baseConfig), { lineWidth: 0 });
}

function parseValidationIssues(message: string): readonly ConfigValidationIssue[] {
  const issueLines = message
    .split("\n")
    .map((line) => line.match(/^\s*-\s+([^:]+):\s*(.+)$/u))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      path: match[1] ?? "",
      message: match[2] ?? message,
    }));
  return issueLines.length > 0 ? issueLines : [{ path: "", message }];
}

function formatConfigPath(path: ConfigPath): string {
  return path.map(String).join(" / ");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
