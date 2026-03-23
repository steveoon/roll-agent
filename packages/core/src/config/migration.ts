const CONFIG_MIGRATION_ISSUE_CODES = {
  deprecatedRouterSection: "deprecated-router-section",
  invalidAskSection: "invalid-ask-section",
  invalidRouterSection: "invalid-router-section",
  routerAskConflict: "router-ask-conflict",
  duplicateEquivalentKeys: "duplicate-equivalent-keys",
  unknownRouterKeys: "unknown-router-keys",
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

interface ConfigMigrationRule {
  readonly id: string;
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
): { ok: true; key: string | undefined; value: unknown } | { ok: false; issue: ConfigMigrationIssue } {
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

function inspectRouterToAskMigration(document: Record<string, unknown>): ConfigMigrationRuleInspection {
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
      const routerMappedValue = getSingleMappedValue(
        "router",
        routerValue,
        field.routerKeys,
      );
      const askMappedValue = getSingleMappedValue("ask", askValue, field.askKeys);

      if (!routerMappedValue.ok) {
        issues.push(
          routerMappedValue.issue,
        );
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

const CONFIG_MIGRATION_RULES = [
  {
    id: "router-to-ask",
    inspect: inspectRouterToAskMigration,
    apply: applyRouterToAskMigration,
  },
] as const satisfies readonly ConfigMigrationRule[];

export function detectKnownConfigMigrations(document: Record<string, unknown>): ConfigMigrationReport {
  const inspections = CONFIG_MIGRATION_RULES.map((rule) => rule.inspect(document));
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
