import { statSync } from "node:fs";
import { basename } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { gateToolCall } from "../build-tools.ts";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  successfulToolResult,
  toolResultToModelOutput,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import {
  TOOL_RESOURCE_ACCESS_MODES,
  executeCoordinatedTool,
  type ToolExecutionPlan,
} from "../tool-execution-coordinator.ts";
import { canonicalFileKey, resolveFilePath } from "./file-io.ts";
import {
  VERIFIER_LEVELS,
  verifiersForFile,
  runVerifier,
  type Verifier,
  type VerifierOutcome,
} from "./verifier-registry.ts";
import { FILE_TOOLS_AGENT_NAME, type ResolvedFileToolsSettings } from "./settings.ts";

export const VERIFY_FILE_TOOL_NAME = "verify_file";

const verifyFileInputSchema = z.object({
  path: z.string().min(1).describe("要验证的文件路径"),
  level: z
    .enum(["fast", "project"])
    .optional()
    .describe("fast=单文件快速检查（默认）；project=项目级完整检查（较慢，需确认）"),
});

export type VerifyFileInput = z.infer<typeof verifyFileInputSchema>;

const VERIFY_FAST_ANNOTATIONS = { readOnlyHint: true } as const;
const VERIFY_PROJECT_ANNOTATIONS = {} as const;

function previewCommandLine(verifier: Verifier, workdir: string, absolutePath: string): string {
  const command = verifier.command(workdir, absolutePath);
  if (command === "builtin-json" || command === "builtin-yaml") {
    return `${verifier.id}（内置校验）`;
  }
  return [command.bin, ...command.args].join(" ");
}

function renderVerifierLine(outcome: VerifierOutcome): string {
  if (outcome.status === "pass") {
    return `✓ ${outcome.id} 通过`;
  }
  if (outcome.status === "fail") {
    const indented = outcome.output
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return `✗ ${outcome.id} 失败：\n${indented}`;
  }
  return `– ${outcome.id} 跳过（${outcome.reason}）`;
}

function renderFastLevelHint(id: string): string {
  return `– ${id} 跳过（level=fast 未包含，用 level: "project" 运行）`;
}

export function renderVerifyReport(
  absolutePath: string,
  outcomes: readonly VerifierOutcome[],
  fastLevelHiddenIds: readonly string[],
): string {
  const lines = [
    ...outcomes.map(renderVerifierLine),
    ...fastLevelHiddenIds.map(renderFastLevelHint),
  ];
  const header = `验证 ${absolutePath}：`;
  const body = lines.length > 0 ? [header, ...lines].join("\n") : header;
  const hasFail = outcomes.some((outcome) => outcome.status === "fail");
  if (hasFail) {
    return `${body}\n\n验证发现问题，请修复后重试`;
  }
  const allSkipped = outcomes.every((outcome) => outcome.status === "skipped");
  if (allSkipped) {
    return `${body}\n\n该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证`;
  }
  const passedIds = outcomes
    .filter((outcome) => outcome.status === "pass")
    .map((outcome) => outcome.id)
    .join(", ");
  return `${body}\n\n验证通过（${passedIds}）`;
}

function levelFilteredVerifiers(
  candidates: readonly Verifier[],
  level: (typeof VERIFIER_LEVELS)[keyof typeof VERIFIER_LEVELS],
): readonly Verifier[] {
  return candidates.filter(
    (verifier) => level === VERIFIER_LEVELS.project || verifier.level === VERIFIER_LEVELS.fast,
  );
}

export async function executeVerifyFile(
  settings: ResolvedFileToolsSettings,
  input: VerifyFileInput,
): Promise<NormalizedToolResult> {
  const path = resolveFilePath(settings.workdir, input.path);
  try {
    statSync(path);
  } catch {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `文件不存在: ${path}`);
  }
  const level = input.level ?? VERIFIER_LEVELS.fast;
  const candidates = verifiersForFile(path);
  const selected = levelFilteredVerifiers(candidates, level);
  const fastLevelHiddenIds =
    level === VERIFIER_LEVELS.fast
      ? candidates
          .filter((verifier) => verifier.level === VERIFIER_LEVELS.project)
          .map((verifier) => verifier.id)
      : [];
  const outcomes: VerifierOutcome[] = [];
  for (const verifier of selected) {
    if (!verifier.detect(settings.workdir, path)) {
      outcomes.push({
        id: verifier.id,
        status: "skipped",
        reason: `未安装或未配置 ${verifier.id}`,
      });
      continue;
    }
    outcomes.push(await runVerifier(verifier, settings.workdir, path));
  }
  const report = renderVerifyReport(path, outcomes, fastLevelHiddenIds);
  return outcomes.some((outcome) => outcome.status === "fail")
    ? failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, report)
    : successfulToolResult(report);
}

export function buildVerifyFileTool(
  settings: ResolvedFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): ToolSet {
  const id = registry.register(FILE_TOOLS_AGENT_NAME, VERIFY_FILE_TOOL_NAME);
  const plan: ToolExecutionPlan = {
    prepare: async (rawInput) => {
      const parsed = verifyFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return failedToolResult(
          TOOL_OUTCOME_KINDS.invalidInput,
          '参数校验失败: path 必须为非空字符串，level 若提供须为 "fast" 或 "project"',
        );
      }
      const path = resolveFilePath(settings.workdir, parsed.data.path);
      const level = parsed.data.level ?? VERIFIER_LEVELS.fast;
      if (level === VERIFIER_LEVELS.project) {
        const detected = verifiersForFile(path).filter((verifier) =>
          verifier.detect(settings.workdir, path),
        );
        const preview =
          detected.length > 0
            ? detected
                .map((verifier) => previewCommandLine(verifier, settings.workdir, path))
                .join("; ")
            : "无可用验证器";
        return gateToolCall(
          ctx,
          FILE_TOOLS_AGENT_NAME,
          VERIFY_FILE_TOOL_NAME,
          parsed.data,
          VERIFY_PROJECT_ANNOTATIONS,
          { explanation: `项目级验证 ${basename(path)}（将执行 ${preview}）` },
        );
      }
      return gateToolCall(
        ctx,
        FILE_TOOLS_AGENT_NAME,
        VERIFY_FILE_TOOL_NAME,
        parsed.data,
        VERIFY_FAST_ANNOTATIONS,
      );
    },
    resources: (rawInput) => {
      const parsed = verifyFileInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return [{ key: `file-tools:${settings.workdir}`, mode: TOOL_RESOURCE_ACCESS_MODES.write }];
      }
      const path = resolveFilePath(settings.workdir, parsed.data.path);
      return [
        { key: `file:${canonicalFileKey(path)}`, mode: TOOL_RESOURCE_ACCESS_MODES.read },
        { key: `verify:${settings.workdir}`, mode: TOOL_RESOURCE_ACCESS_MODES.write },
      ];
    },
  };
  ctx.coordinator?.register(id, plan);
  return {
    [id]: tool({
      description:
        '验证文件正确性，按扩展名自动选择验证器（如 eslint/tsc/ruff/JSON/YAML/gofmt 等），零配置探测本地是否可用。level 默认 "fast"（单文件快速检查，免确认）；level: "project" 额外运行项目级检查（如 tsc --noEmit、cargo check、go vet，可能执行任意代码，较慢且需用户确认）。修改代码文件后应调用本工具验证，发现问题应先修复再汇报完成。',
      inputSchema: verifyFileInputSchema,
      toModelOutput: ({ output }) => toolResultToModelOutput(output),
      execute: (input: VerifyFileInput, options): Promise<NormalizedToolResult> =>
        executeCoordinatedTool(
          ctx.coordinator,
          plan,
          id,
          options.toolCallId,
          input,
          options.abortSignal,
          () => executeVerifyFile(settings, input),
        ),
    }),
  };
}
