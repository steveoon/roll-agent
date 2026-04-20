import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentEnvCheckItem, AgentEnvCheckReport } from "./helpers.ts";

export const DIAGNOSTIC_TOOL_CANDIDATES = ["diagnostic_status", "browser_status"] as const;

export type DiagnosticToolName = (typeof DIAGNOSTIC_TOOL_CANDIDATES)[number];

const EFFECTIVE_ENV_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

export const EffectiveEnvSourceSchema = z.object({
  present: z.boolean(),
  fingerprint: z.string().regex(EFFECTIVE_ENV_FINGERPRINT_PATTERN).optional(),
});

export const AgentRuntimeEnvDiagnosticPayloadSchema = z.object({
  effectiveEnvSources: z.record(EffectiveEnvSourceSchema),
});

export type AgentRuntimeEnvDiagnosticPayload = z.infer<typeof AgentRuntimeEnvDiagnosticPayloadSchema>;

export type AgentRuntimeEnvInspection =
  | {
      readonly status: "verified";
      readonly toolName: DiagnosticToolName;
      readonly payload: AgentRuntimeEnvDiagnosticPayload;
    }
  | {
      readonly status: "unverified";
      readonly reason: "agent-not-running" | "connection-failed" | "diagnostic-tool-unavailable";
      readonly message: string;
    };

export type AgentRuntimeEnvVerification =
  | {
      readonly verified: false;
      readonly reason: "agent-not-running" | "connection-failed" | "diagnostic-tool-unavailable";
      readonly message: string;
    }
  | {
      readonly verified: true;
      readonly present: false;
    }
  | {
      readonly verified: true;
      readonly present: true;
      readonly fingerprint: string;
      readonly matchesAgentsEnv: boolean;
    };

export interface AgentRuntimeEnvCheckItem extends AgentEnvCheckItem {
  readonly configuredInAgentsEnv: boolean;
  readonly runtime: AgentRuntimeEnvVerification;
}

export interface AgentRuntimeEnvCheckReport {
  readonly items: readonly AgentRuntimeEnvCheckItem[];
  readonly inspection: AgentRuntimeEnvInspection;
  readonly missingRequired: readonly AgentRuntimeEnvCheckItem[];
  readonly ephemeralItems: readonly AgentRuntimeEnvCheckItem[];
}

export interface AgentRuntimeEnvSummary {
  readonly status: "ok" | "warn" | "fail";
  readonly message: string;
}

export function inspectAgentRuntimeEnvRequirements(
  report: AgentEnvCheckReport,
  configuredEnv: Readonly<Record<string, string>> | undefined,
  inspection: AgentRuntimeEnvInspection,
): AgentRuntimeEnvCheckReport {
  const items = report.items.map((item) => {
    const configuredValue = configuredEnv?.[item.name];
    const configuredInAgentsEnv = configuredValue !== undefined;

    if (inspection.status === "unverified") {
      return {
        ...item,
        configuredInAgentsEnv,
        runtime: {
          verified: false,
          reason: inspection.reason,
          message: inspection.message,
        },
      } satisfies AgentRuntimeEnvCheckItem;
    }

    const runtimeEntry = inspection.payload.effectiveEnvSources[item.name];
    if (runtimeEntry?.present) {
      return {
        ...item,
        configuredInAgentsEnv,
        runtime: {
          verified: true,
          present: true,
          fingerprint: runtimeEntry.fingerprint ?? "",
          matchesAgentsEnv:
            configuredValue !== undefined && createEnvFingerprint(configuredValue) === runtimeEntry.fingerprint,
        },
      } satisfies AgentRuntimeEnvCheckItem;
    }

    return {
      ...item,
      configuredInAgentsEnv,
      runtime: {
        verified: true,
        present: false,
      },
    } satisfies AgentRuntimeEnvCheckItem;
  });

  return {
    items,
    inspection,
    missingRequired: items.filter((item) => item.required && isEffectivelyMissing(item)),
    ephemeralItems: items.filter(isEffectivelyEphemeral),
  };
}

export function summarizeAgentRuntimeEnvReport(report: AgentRuntimeEnvCheckReport): AgentRuntimeEnvSummary {
  if (report.missingRequired.length > 0) {
    const missingNames = joinItemNames(report.missingRequired);
    if (report.inspection.status === "verified") {
      return {
        status: "fail",
        message: `运行态缺失: ${missingNames}`,
      };
    }

    return {
      status: "fail",
      message: `${formatDeclarationMissingMessage(report)}；${report.inspection.message}`,
    };
  }

  if (report.ephemeralItems.length > 0) {
    return {
      status: "warn",
      message: `运行态漂移: ${joinItemNames(report.ephemeralItems)}`,
    };
  }

  if (report.inspection.status === "verified") {
    return {
      status: "ok",
      message: `声明的必填项已在运行态生效（${report.inspection.toolName}）`,
    };
  }

  const processEnvOnlyRequired = report.items.filter(
    (item) => item.required && item.source === "process.env",
  );
  if (processEnvOnlyRequired.length > 0) {
    return {
      status: "warn",
      message: `依赖当前 shell 环境: ${joinItemNames(processEnvOnlyRequired)}；${report.inspection.message}`,
    };
  }

  if (report.inspection.reason === "diagnostic-tool-unavailable") {
    return {
      status: "ok",
      message: `声明的必填项已满足（${report.inspection.message}）`,
    };
  }

  return {
    status: "warn",
    message: `声明的必填项已满足；${report.inspection.message}`,
  };
}

export function formatAgentEnvDeclarationSource(item: AgentEnvCheckItem): string {
  switch (item.source) {
    case "agents.env":
      return "已配置于 agents.env";
    case "process.env":
      return "仅当前 shell 环境";
    case "default":
      return `默认值 (${item.default})`;
    case "missing":
      return "缺失";
  }
}

export function formatAgentRuntimeVerification(report: AgentRuntimeEnvCheckReport): string {
  if (report.inspection.status === "verified") {
    return `已验证（${report.inspection.toolName}）`;
  }

  return `未校验（${report.inspection.message}）`;
}

export function formatAgentEnvRuntimeStatus(item: AgentRuntimeEnvCheckItem): string | undefined {
  if (!item.runtime.verified) {
    return undefined;
  }

  if (item.runtime.present) {
    if (item.runtime.matchesAgentsEnv) {
      return "✓ from yaml (stable)";
    }

    return item.configuredInAgentsEnv
      ? "⚠ differs from yaml (ephemeral)"
      : "⚠ from shell (ephemeral)";
  }

  if (item.source === "default") {
    return "未设置（使用默认值）";
  }

  if (item.source === "process.env") {
    return "✗ 当前运行 agent 未看到该变量";
  }

  return "✗ missing";
}

function createEnvFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function isEffectivelyMissing(item: AgentRuntimeEnvCheckItem): boolean {
  if (!item.runtime.verified) {
    return item.source === "missing";
  }

  if (item.runtime.present) {
    return false;
  }

  return item.source !== "default";
}

function isEffectivelyEphemeral(item: AgentRuntimeEnvCheckItem): boolean {
  return item.runtime.verified && item.runtime.present && !item.runtime.matchesAgentsEnv;
}

function formatDeclarationMissingMessage(report: AgentRuntimeEnvCheckReport): string {
  return `缺少必填项: ${joinItemNames(report.missingRequired)}`;
}

function joinItemNames(items: readonly AgentEnvCheckItem[]): string {
  return items.map((item) => item.name).join(", ");
}
