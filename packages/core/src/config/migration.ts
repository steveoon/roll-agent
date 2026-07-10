import { camelToKebab, CONFIG_KEY_CODEC, kebabToCamel, type KeyCodecNode } from "./key-codec.ts";

const CONFIG_MIGRATION_ISSUE_CODES = {
  deprecatedRouterSection: "deprecated-router-section",
  invalidAskSection: "invalid-ask-section",
  invalidRouterSection: "invalid-router-section",
  routerAskConflict: "router-ask-conflict",
  duplicateEquivalentKeys: "duplicate-equivalent-keys",
  unknownRouterKeys: "unknown-router-keys",
  legacyCamelCaseAgentEnvKey: "legacy-camelcase-agent-env-key",
  legacyAgentEnvKeyConflict: "legacy-agent-env-key-conflict",
  deprecatedRuntimeBashSection: "deprecated-runtime-bash-section",
  invalidRuntimeBashSection: "invalid-runtime-bash-section",
  invalidRuntimeShellSection: "invalid-runtime-shell-section",
  runtimeShellConflict: "runtime-shell-conflict",
} as const;

type ConfigMigrationIssueCode =
  (typeof CONFIG_MIGRATION_ISSUE_CODES)[keyof typeof CONFIG_MIGRATION_ISSUE_CODES];

const ROUTER_MIGRATABLE_FIELDS = {
  llmModel: {
    routerKeys: ["llm-model", "llmModel"],
    askKeys: ["llm-model", "llmModel"],
    targetAskKey: "llm-model",
  },
  confirmThreshold: {
    routerKeys: ["confirm-threshold", "confirmThreshold"],
    askKeys: ["confirm-threshold", "confirmThreshold"],
    targetAskKey: "confirm-threshold",
  },
} as const;

const ROUTER_DEPRECATED_KEYS = [
  ...ROUTER_MIGRATABLE_FIELDS.llmModel.routerKeys,
  ...ROUTER_MIGRATABLE_FIELDS.confirmThreshold.routerKeys,
  "mode",
] as const;

const BLOCKING_MIGRATION_ISSUE_CODES = new Set<ConfigMigrationIssueCode>([
  CONFIG_MIGRATION_ISSUE_CODES.invalidAskSection,
  CONFIG_MIGRATION_ISSUE_CODES.invalidRouterSection,
  CONFIG_MIGRATION_ISSUE_CODES.routerAskConflict,
  CONFIG_MIGRATION_ISSUE_CODES.unknownRouterKeys,
  CONFIG_MIGRATION_ISSUE_CODES.legacyAgentEnvKeyConflict,
  CONFIG_MIGRATION_ISSUE_CODES.invalidRuntimeBashSection,
  CONFIG_MIGRATION_ISSUE_CODES.invalidRuntimeShellSection,
  CONFIG_MIGRATION_ISSUE_CODES.runtimeShellConflict,
]);

export interface ConfigMigrationIssue {
  readonly code: ConfigMigrationIssueCode;
  readonly message: string;
}

export interface ConfigMigrationReport {
  readonly needsMigration: boolean;
  readonly canAutoMigrate: boolean;
  readonly issues: readonly ConfigMigrationIssue[];
}

export type ApplyKnownConfigMigrationsResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly document: Record<string, unknown>;
      readonly issues: readonly ConfigMigrationIssue[];
      readonly summary: readonly string[];
    }
  | {
      readonly ok: false;
      readonly changed: false;
      readonly issues: readonly ConfigMigrationIssue[];
    };

interface ConfigMigrationRuleInspection {
  readonly matches: boolean;
  readonly canAutoMigrate: boolean;
  readonly issues: readonly ConfigMigrationIssue[];
}

export type ConfigMigrationScope = "llm" | "ask" | "agents" | "runtime";

interface ConfigMigrationRule {
  readonly id: string;
  readonly scopes: ReadonlySet<ConfigMigrationScope>;
  inspect(document: Record<string, unknown>): ConfigMigrationRuleInspection;
  apply(document: Record<string, unknown>): ApplyKnownConfigMigrationsResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnStringKey(
  record: Record<string, unknown>,
  key: string,
): key is keyof typeof record & string {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function createIssue(code: ConfigMigrationIssueCode, message: string): ConfigMigrationIssue {
  return { code, message };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
}

type RuntimeShellNormalizationResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly conflictPath: string };

type KeyCodecNormalizationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly conflictPath: string };

function getRuntimeShellKeyCodec(): KeyCodecNode {
  if (CONFIG_KEY_CODEC.kind !== "object") {
    throw new Error("runtime shell key codec is unavailable");
  }
  const runtime = CONFIG_KEY_CODEC.fields["runtime"];
  if (runtime?.kind !== "object") {
    throw new Error("runtime shell key codec is unavailable");
  }
  const shell = runtime.fields["shell"];
  if (shell?.kind !== "object") {
    throw new Error("runtime shell key codec is unavailable");
  }
  return shell;
}

function normalizeWithKeyCodec(
  value: unknown,
  node: KeyCodecNode,
  path: readonly string[],
): KeyCodecNormalizationResult {
  if (!isRecord(value) || node.kind === "leaf") {
    return { ok: true, value };
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const canonicalKey = node.kind === "object" ? kebabToCamel(key) : key;
    const childNode = node.kind === "object" ? node.fields[canonicalKey] : node.value;
    const normalizedChild =
      childNode === undefined
        ? { ok: true as const, value: child }
        : normalizeWithKeyCodec(child, childNode, [...path, canonicalKey]);
    if (!normalizedChild.ok) {
      return normalizedChild;
    }

    if (hasOwnStringKey(normalized, canonicalKey)) {
      if (!deepEqual(normalized[canonicalKey], normalizedChild.value)) {
        return {
          ok: false,
          conflictPath: [...path, canonicalKey].join("."),
        };
      }
      continue;
    }
    normalized[canonicalKey] = normalizedChild.value;
  }
  return { ok: true, value: normalized };
}

function normalizeRuntimeShellSection(
  section: Record<string, unknown>,
  sectionPath: string,
): RuntimeShellNormalizationResult {
  const result = normalizeWithKeyCodec(section, getRuntimeShellKeyCodec(), [sectionPath]);
  if (!result.ok) {
    return result;
  }
  return isRecord(result.value) ? { ok: true, value: result.value } : { ok: true, value: section };
}

function dedupeEquivalentAliasKeys(value: unknown, node: KeyCodecNode): unknown {
  if (!isRecord(value) || node.kind === "leaf") {
    return value;
  }
  const deduped: Record<string, unknown> = {};
  const seenCanonicalKeys = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    const canonicalKey = node.kind === "object" ? kebabToCamel(key) : key;
    if (seenCanonicalKeys.has(canonicalKey)) {
      continue;
    }
    seenCanonicalKeys.add(canonicalKey);
    const childNode = node.kind === "object" ? node.fields[canonicalKey] : node.value;
    deduped[key] = childNode === undefined ? child : dedupeEquivalentAliasKeys(child, childNode);
  }
  return deduped;
}

function findPresentKeys(
  record: Record<string, unknown>,
  candidateKeys: readonly string[],
): readonly string[] {
  return candidateKeys.filter((key) => hasOwnStringKey(record, key));
}

function getSingleMappedValue(
  sectionName: string,
  record: Record<string, unknown>,
  candidateKeys: readonly string[],
):
  | { ok: true; key: string | undefined; value: unknown }
  | { ok: false; issue: ConfigMigrationIssue } {
  const presentKeys = findPresentKeys(record, candidateKeys);
  if (presentKeys.length === 0) {
    return { ok: true, key: undefined, value: undefined };
  }

  const [firstKey] = presentKeys;
  const firstValue = firstKey ? record[firstKey] : undefined;
  const hasConflict = presentKeys.some((key) => record[key] !== firstValue);
  if (hasConflict) {
    return {
      ok: false,
      issue: createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.duplicateEquivalentKeys,
        `\`${sectionName}\` 同时包含等价键 ${presentKeys.join(", ")} 且值不一致，请手动处理。`,
      ),
    };
  }

  return { ok: true, key: firstKey, value: firstValue };
}

function inspectRouterToAskMigration(
  document: Record<string, unknown>,
): ConfigMigrationRuleInspection {
  if (!hasOwnStringKey(document, "router")) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }

  const issues: ConfigMigrationIssue[] = [
    createIssue(
      CONFIG_MIGRATION_ISSUE_CODES.deprecatedRouterSection,
      "`router` 配置段已废弃，请改用 `ask`。",
    ),
    createIssue(
      CONFIG_MIGRATION_ISSUE_CODES.deprecatedRouterSection,
      "将 `router.llm-model` 迁移为 `ask.llm-model`。",
    ),
    createIssue(
      CONFIG_MIGRATION_ISSUE_CODES.deprecatedRouterSection,
      "将 `router.confirm-threshold` 迁移为 `ask.confirm-threshold`。",
    ),
    createIssue(
      CONFIG_MIGRATION_ISSUE_CODES.deprecatedRouterSection,
      "删除 `router.mode`；命令本身已决定策略（`run` / `ask` / `chat`）。",
    ),
  ];

  const routerValue = document["router"];
  if (!isRecord(routerValue)) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.invalidRouterSection,
        "`router` 配置段不是对象，无法自动迁移，请手动修复。",
      ),
    );
    return { matches: true, canAutoMigrate: false, issues };
  }

  const unknownKeys = Object.keys(routerValue).filter(
    (key) => !(ROUTER_DEPRECATED_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.unknownRouterKeys,
        `\`router\` 包含无法自动迁移的未知键：${unknownKeys.join(", ")}。`,
      ),
    );
  }

  const askValue = document["ask"];
  if (askValue !== undefined && !isRecord(askValue)) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.invalidAskSection,
        "`ask` 配置段不是对象，无法自动迁移，请手动修复。",
      ),
    );
  }

  if (isRecord(askValue)) {
    for (const fieldName of Object.keys(ROUTER_MIGRATABLE_FIELDS) as Array<
      keyof typeof ROUTER_MIGRATABLE_FIELDS
    >) {
      const field = ROUTER_MIGRATABLE_FIELDS[fieldName];
      const routerMappedValue = getSingleMappedValue("router", routerValue, field.routerKeys);
      const askMappedValue = getSingleMappedValue("ask", askValue, field.askKeys);

      if (!routerMappedValue.ok) {
        issues.push(routerMappedValue.issue);
        continue;
      }

      if (!askMappedValue.ok) {
        issues.push(askMappedValue.issue);
        continue;
      }

      if (
        routerMappedValue.key &&
        askMappedValue.key &&
        askMappedValue.value !== routerMappedValue.value
      ) {
        issues.push(
          createIssue(
            CONFIG_MIGRATION_ISSUE_CODES.routerAskConflict,
            `\`router.${field.targetAskKey}\` 与 \`ask.${field.targetAskKey}\` 同时存在且值冲突，请手动处理。`,
          ),
        );
      }
    }
  }

  const canAutoMigrate = !issues.some((issue) => BLOCKING_MIGRATION_ISSUE_CODES.has(issue.code));

  return {
    matches: true,
    canAutoMigrate,
    issues,
  };
}

function applyRouterToAskMigration(
  document: Record<string, unknown>,
): ApplyKnownConfigMigrationsResult {
  const inspection = inspectRouterToAskMigration(document);
  if (!inspection.matches) {
    return {
      ok: true,
      changed: false,
      document: structuredClone(document) as Record<string, unknown>,
      issues: [],
      summary: [],
    };
  }

  if (!inspection.canAutoMigrate) {
    return {
      ok: false,
      changed: false,
      issues: inspection.issues,
    };
  }

  const nextDocument = structuredClone(document) as Record<string, unknown>;
  const routerSection = nextDocument["router"];
  if (!isRecord(routerSection)) {
    return {
      ok: false,
      changed: false,
      issues: inspection.issues,
    };
  }

  const existingAskSection = nextDocument["ask"];
  const askSection = isRecord(existingAskSection) ? existingAskSection : {};
  let askSectionChanged = false;
  const summary: string[] = [];

  for (const fieldName of Object.keys(ROUTER_MIGRATABLE_FIELDS) as Array<
    keyof typeof ROUTER_MIGRATABLE_FIELDS
  >) {
    const field = ROUTER_MIGRATABLE_FIELDS[fieldName];
    const routerMappedValue = getSingleMappedValue("router", routerSection, field.routerKeys);
    if (!routerMappedValue.ok) {
      return {
        ok: false,
        changed: false,
        issues: [routerMappedValue.issue],
      };
    }

    if (!routerMappedValue.key) {
      continue;
    }

    const askMappedValue = getSingleMappedValue("ask", askSection, field.askKeys);
    if (!askMappedValue.ok) {
      return {
        ok: false,
        changed: false,
        issues: [askMappedValue.issue],
      };
    }

    if (!askMappedValue.key) {
      askSection[field.targetAskKey] = routerMappedValue.value;
      askSectionChanged = true;
      summary.push(`将 \`router.${field.targetAskKey}\` 迁移到 \`ask.${field.targetAskKey}\``);
    } else {
      summary.push(`移除已废弃的 \`router.${field.targetAskKey}\``);
    }

    for (const key of field.routerKeys) {
      if (hasOwnStringKey(routerSection, key)) {
        delete routerSection[key];
      }
    }
  }

  if (hasOwnStringKey(routerSection, "mode")) {
    delete routerSection["mode"];
    summary.push("删除已废弃的 `router.mode`");
  }

  if (askSectionChanged) {
    nextDocument["ask"] = askSection;
  }

  if (Object.keys(routerSection).length === 0) {
    delete nextDocument["router"];
    summary.push("删除空的 `router` 配置段");
  }

  return {
    ok: true,
    changed: summary.length > 0,
    document: nextDocument,
    issues: inspection.issues,
    summary,
  };
}

const CANONICAL_AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isNonCanonicalAgentName(key: string): boolean {
  return !CANONICAL_AGENT_NAME_PATTERN.test(key);
}

function canonicalizeAgentName(key: string): string | undefined {
  const candidate = camelToKebab(key).toLowerCase();
  return CANONICAL_AGENT_NAME_PATTERN.test(candidate) ? candidate : undefined;
}

function inspectLegacyAgentEnvKeys(
  document: Record<string, unknown>,
): ConfigMigrationRuleInspection {
  const agents = document["agents"];
  if (!isRecord(agents)) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }
  const env = agents["env"];
  if (!isRecord(env)) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }

  const legacy = Object.keys(env).filter(isNonCanonicalAgentName);
  if (legacy.length === 0) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }

  const issues: ConfigMigrationIssue[] = [];
  let hasBlocking = false;

  for (const key of legacy) {
    const canonical = canonicalizeAgentName(key);
    if (canonical === undefined) {
      hasBlocking = true;
      issues.push(
        createIssue(
          CONFIG_MIGRATION_ISSUE_CODES.legacyAgentEnvKeyConflict,
          `\`agents.env.${key}\` 命名不符合 kebab-case 规范，无法自动迁移，请手动重命名。`,
        ),
      );
      continue;
    }
    if (hasOwnStringKey(env, canonical)) {
      hasBlocking = true;
      issues.push(
        createIssue(
          CONFIG_MIGRATION_ISSUE_CODES.legacyAgentEnvKeyConflict,
          `\`agents.env\` 下同时存在 \`${key}\` 与 \`${canonical}\`，无法自动合并，请手动处理。`,
        ),
      );
      continue;
    }
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.legacyCamelCaseAgentEnvKey,
        `\`agents.env.${key}\` 应使用 kebab-case（\`${canonical}\`）。`,
      ),
    );
  }

  return {
    matches: true,
    canAutoMigrate: !hasBlocking,
    issues,
  };
}

function applyLegacyAgentEnvKeys(
  document: Record<string, unknown>,
): ApplyKnownConfigMigrationsResult {
  const inspection = inspectLegacyAgentEnvKeys(document);
  if (!inspection.matches) {
    return {
      ok: true,
      changed: false,
      document: structuredClone(document) as Record<string, unknown>,
      issues: [],
      summary: [],
    };
  }
  if (!inspection.canAutoMigrate) {
    return {
      ok: false,
      changed: false,
      issues: inspection.issues,
    };
  }

  const next = structuredClone(document) as Record<string, unknown>;
  const agents = next["agents"];
  if (!isRecord(agents)) {
    return { ok: false, changed: false, issues: inspection.issues };
  }
  const env = agents["env"];
  if (!isRecord(env)) {
    return { ok: false, changed: false, issues: inspection.issues };
  }

  const summary: string[] = [];
  for (const key of Object.keys(env).filter(isNonCanonicalAgentName)) {
    const canonical = canonicalizeAgentName(key);
    if (canonical === undefined) {
      continue;
    }
    env[canonical] = env[key];
    delete env[key];
    summary.push(`将 \`agents.env.${key}\` 重命名为 \`agents.env.${canonical}\``);
  }

  return {
    ok: true,
    changed: summary.length > 0,
    document: next,
    issues: inspection.issues,
    summary,
  };
}

function inspectRuntimeShellMigration(
  document: Record<string, unknown>,
): ConfigMigrationRuleInspection {
  const runtime = document["runtime"];
  if (!isRecord(runtime)) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }
  if (!hasOwnStringKey(runtime, "bash")) {
    return { matches: false, canAutoMigrate: false, issues: [] };
  }

  const issues: ConfigMigrationIssue[] = [
    createIssue(
      CONFIG_MIGRATION_ISSUE_CODES.deprecatedRuntimeBashSection,
      "`runtime.bash` 配置段已废弃，请改用 `runtime.shell`。",
    ),
  ];
  const bash = runtime["bash"];
  if (!isRecord(bash)) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.invalidRuntimeBashSection,
        "`runtime.bash` 配置段不是对象，无法自动迁移，请手动修复。",
      ),
    );
  }

  const shell = runtime["shell"];
  if (shell !== undefined && !isRecord(shell)) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.invalidRuntimeShellSection,
        "`runtime.shell` 配置段不是对象，无法自动迁移，请手动修复。",
      ),
    );
  }

  const normalizedBash = isRecord(bash)
    ? normalizeRuntimeShellSection(bash, "runtime.bash")
    : undefined;
  const normalizedShell = isRecord(shell)
    ? normalizeRuntimeShellSection(shell, "runtime.shell")
    : undefined;

  for (const normalization of [normalizedBash, normalizedShell]) {
    if (normalization !== undefined && !normalization.ok) {
      issues.push(
        createIssue(
          CONFIG_MIGRATION_ISSUE_CODES.runtimeShellConflict,
          `\`${normalization.conflictPath}\` 同时包含等价键且值冲突，请手动处理。`,
        ),
      );
    }
  }

  if (
    normalizedBash?.ok === true &&
    normalizedShell?.ok === true &&
    !deepEqual(normalizedBash.value, normalizedShell.value)
  ) {
    issues.push(
      createIssue(
        CONFIG_MIGRATION_ISSUE_CODES.runtimeShellConflict,
        "`runtime.bash` 与 `runtime.shell` 同时存在且值冲突，请手动处理。",
      ),
    );
  }

  const canAutoMigrate = !issues.some((issue) => BLOCKING_MIGRATION_ISSUE_CODES.has(issue.code));
  return { matches: true, canAutoMigrate, issues };
}

function applyRuntimeShellMigration(
  document: Record<string, unknown>,
): ApplyKnownConfigMigrationsResult {
  const inspection = inspectRuntimeShellMigration(document);
  if (!inspection.matches) {
    return {
      ok: true,
      changed: false,
      document: structuredClone(document) as Record<string, unknown>,
      issues: [],
      summary: [],
    };
  }
  if (!inspection.canAutoMigrate) {
    return {
      ok: false,
      changed: false,
      issues: inspection.issues,
    };
  }

  const next = structuredClone(document) as Record<string, unknown>;
  const runtime = next["runtime"];
  if (!isRecord(runtime)) {
    return { ok: false, changed: false, issues: inspection.issues };
  }
  const bash = runtime["bash"];
  if (!isRecord(bash)) {
    return { ok: false, changed: false, issues: inspection.issues };
  }
  const summary: string[] = [];
  if (!hasOwnStringKey(runtime, "shell")) {
    runtime["shell"] = dedupeEquivalentAliasKeys(bash, getRuntimeShellKeyCodec());
    summary.push("将 `runtime.bash` 迁移为 `runtime.shell`");
  } else {
    summary.push("删除已废弃的 `runtime.bash`");
  }
  delete runtime["bash"];

  return {
    ok: true,
    changed: true,
    document: next,
    issues: inspection.issues,
    summary,
  };
}

const CONFIG_MIGRATION_RULES: readonly ConfigMigrationRule[] = [
  {
    id: "router-to-ask",
    scopes: new Set<ConfigMigrationScope>(["ask"]),
    inspect: inspectRouterToAskMigration,
    apply: applyRouterToAskMigration,
  },
  {
    id: "legacy-agent-env-keys",
    scopes: new Set<ConfigMigrationScope>(["agents"]),
    inspect: inspectLegacyAgentEnvKeys,
    apply: applyLegacyAgentEnvKeys,
  },
  {
    id: "runtime-bash-to-shell",
    scopes: new Set<ConfigMigrationScope>(["runtime"]),
    inspect: inspectRuntimeShellMigration,
    apply: applyRuntimeShellMigration,
  },
];

export function detectKnownConfigMigrations(
  document: Record<string, unknown>,
  options: { readonly scope?: ConfigMigrationScope } = {},
): ConfigMigrationReport {
  const { scope } = options;
  const rules =
    scope !== undefined
      ? CONFIG_MIGRATION_RULES.filter((rule) => rule.scopes.has(scope))
      : CONFIG_MIGRATION_RULES;
  const inspections = rules.map((rule) => rule.inspect(document));
  const matchingInspections = inspections.filter((inspection) => inspection.matches);

  if (matchingInspections.length === 0) {
    return {
      needsMigration: false,
      canAutoMigrate: false,
      issues: [],
    };
  }

  return {
    needsMigration: true,
    canAutoMigrate: matchingInspections.every((inspection) => inspection.canAutoMigrate),
    issues: matchingInspections.flatMap((inspection) => inspection.issues),
  };
}

export function applyKnownConfigMigrations(
  document: Record<string, unknown>,
): ApplyKnownConfigMigrationsResult {
  let current = structuredClone(document) as Record<string, unknown>;
  const summary: string[] = [];
  const issues: ConfigMigrationIssue[] = [];
  let changed = false;

  for (const rule of CONFIG_MIGRATION_RULES) {
    const result = rule.apply(current);
    if (!result.ok) {
      return {
        ok: false,
        changed: false,
        issues: result.issues,
      };
    }

    current = result.document;
    if (result.changed) {
      changed = true;
      summary.push(...result.summary);
    }
    issues.push(...result.issues);
  }

  return {
    ok: true,
    changed,
    document: current,
    summary,
    issues,
  };
}

export function formatConfigMigrationError(
  configPath: string,
  report: ConfigMigrationReport,
): string {
  const lines = [`Config validation failed (${configPath}):`];

  for (const issue of report.issues) {
    lines.push(`  - ${issue.message}`);
  }

  if (report.canAutoMigrate) {
    lines.push("  - 可运行 `roll config migrate` 自动迁移当前配置。");
  } else if (report.needsMigration) {
    lines.push("  - 检测到配置迁移冲突，请手动处理后再重试。");
  }

  return lines.join("\n");
}
