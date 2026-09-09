import { createHash } from "node:crypto";
import { defineTool, StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import {
  BrowserExecuteInputSchema,
  BrowserExecuteResultSchema,
  BrowserScriptConditionSchema,
  compileBrowserScript,
} from "@roll-agent/browser";
import type { BrowserExecuteInput, BrowserExecuteResult } from "@roll-agent/browser";
import { z } from "zod";
import { WorkflowStore, workflowDraftSchema, workflowStatusSchema } from "../workflows/store.ts";
import type { StoredWorkflow } from "../workflows/store.ts";
import { validateParameters } from "../workflows/parameters.ts";
import { getRuntime } from "../runtime-holder.ts";
import {
  approveToolAction,
  createToolActionApprovalRequest,
  ToolActionApprovalSchema,
} from "../tool-action-approval.ts";

const identitySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
export const BrowserWorkflowListInputSchema = z
  .object({ url: z.string().url().max(8000) })
  .strict();
export const BrowserWorkflowSaveDraftInputSchema = z
  .object({ draft: workflowDraftSchema })
  .strict();
export const BrowserWorkflowExecutionInputSchema = identitySchema
  .extend({
    pageId: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    scriptApproval: z
      .object({ id: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export const BrowserWorkflowSetStatusInputSchema = identitySchema
  .extend({
    status: z.enum(["active", "disabled"]),
    toolActionApproval: ToolActionApprovalSchema.optional(),
  })
  .strict();
const metadataSchema = identitySchema.extend({
  name: z.string(),
  status: workflowStatusSchema,
  validationCount: z.number().int().nonnegative(),
});
export const BrowserWorkflowExecutionOutputSchema = z.object({
  workflow: identitySchema.extend({ status: workflowStatusSchema }),
  result: BrowserExecuteResultSchema,
  needsReexploration: z.boolean(),
  validationRecorded: z.boolean().optional(),
});

type ExecutionOptions = {
  workflowKey?: string;
  beforeAction?: () => Promise<void>;
  toolName?: string;
};
type WorkflowDependencies = {
  store: WorkflowStore;
  execute: (
    input: BrowserExecuteInput,
    ctx: AgentContext,
    options?: ExecutionOptions,
  ) => Promise<{ result: BrowserExecuteResult; executionDigest: string }>;
  readPageUrl: (pageId: string) => Promise<string>;
  compile: typeof compileBrowserScript;
};
const defaults: WorkflowDependencies = {
  store: new WorkflowStore(),
  execute: async (input, ctx, options) =>
    await (await import("../browser-execution.ts")).executeBrowserTool(input, ctx, options),
  readPageUrl: async (pageId) => {
    const page = (await getRuntime().listNativePages()).find(
      (candidate) => candidate.targetId === pageId,
    );
    if (!page) {
      throw new StructuredToolError({
        code: "not_found",
        message: "Workflow page was not found; select an existing page",
      });
    }
    return page.url;
  },
  compile: compileBrowserScript,
};
let dependencies = defaults;
export function setBrowserWorkflowDepsForTests(overrides?: Partial<WorkflowDependencies>): void {
  dependencies = overrides ? { ...defaults, ...overrides } : defaults;
}

function metadata(workflow: StoredWorkflow) {
  return {
    id: workflow.draft.id,
    version: workflow.version,
    name: workflow.draft.name,
    status: workflow.state.status,
    validationCount: workflow.state.validations.length,
  };
}
function assertApplicable(workflow: StoredWorkflow, url: string): void {
  const location = new URL(url);
  if (
    !workflow.draft.appliesTo.origins.includes(location.origin) ||
    (workflow.draft.appliesTo.pathPrefix &&
      !location.pathname.startsWith(workflow.draft.appliesTo.pathPrefix))
  ) {
    throw new StructuredToolError({
      code: "workflow_not_applicable",
      message: "Workflow does not apply to the selected page",
    });
  }
}
async function compiled(workflow: StoredWorkflow): Promise<void> {
  const result = await dependencies.compile(workflow.draft.source);
  if (!result.valid) {
    throw new StructuredToolError({
      code: "invalid_workflow",
      message: "Workflow source failed compilation",
    });
  }
}
function executionInput(
  workflow: StoredWorkflow,
  input: z.infer<typeof BrowserWorkflowExecutionInputSchema>,
): BrowserExecuteInput {
  validateParameters(workflow.draft.parameterSchema, input.args);
  return BrowserExecuteInputSchema.parse({
    pageId: input.pageId,
    source: workflow.draft.source,
    args: input.args,
    capabilities: workflow.draft.capabilities,
    allowedOrigins: workflow.draft.allowedOrigins,
    preconditions: workflow.draft.preconditions,
    postconditions: workflow.draft.postconditions,
    ...(input.scriptApproval ? { scriptApproval: input.scriptApproval } : {}),
  });
}

const reexplorationCodes = new Set([
  "stale_ref",
  "stale_target",
  "ambiguous_target",
  "not_found",
  "target_not_found",
  "verification_failed",
  "coverage_gap",
  "target_disabled",
  "target_occluded",
  "target_obscured",
  "control_unassociated",
  "unsupported_control",
  "focus_changed",
  "target_moved",
]);
async function executeWorkflow(
  input: z.infer<typeof BrowserWorkflowExecutionInputSchema>,
  ctx: AgentContext,
  validate: boolean,
) {
  const deps = dependencies;
  const workflow = await deps.store.getVersion(input.id, input.version);
  if (!validate && workflow.state.status !== "active") {
    throw new StructuredToolError({
      code: "workflow_inactive",
      message: "Only explicitly enabled workflow versions may run",
    });
  }
  assertApplicable(workflow, await deps.readPageUrl(input.pageId));
  const parsed = executionInput(workflow, input);
  const beforeAction = async (): Promise<void> => {
    const current = await deps.store.getVersion(input.id, input.version);
    const validationStopped =
      validate &&
      current.state.status !== workflow.state.status &&
      ["disabled", "suspended"].includes(current.state.status);
    if ((!validate && current.state.status !== "active") || validationStopped) {
      throw new StructuredToolError({
        code: "workflow_inactive",
        message: "Workflow was disabled or suspended while executing",
      });
    }
  };
  const { result, executionDigest } = await deps.execute(parsed, ctx, {
    workflowKey: `${input.id}:${input.version}`,
    toolName: validate ? "browser_workflow_validate" : "browser_workflow_run",
    beforeAction,
  });
  const needsReexploration =
    result.status === "failed" &&
    result.error !== undefined &&
    reexplorationCodes.has(result.error.code);
  if (needsReexploration) await deps.store.setStatus(input.id, input.version, "suspended");
  let validationRecorded = false;
  if (
    validate &&
    result.status === "completed" &&
    result.verification === "passed" &&
    result.metrics.verifiedAssertions > 0
  ) {
    // Receipts originate only from the server executor; MCP input has no receipt field.
    await deps.store.recordValidation(input.id, input.version, {
      compiled: true,
      success: true,
      verifiedAssertions: result.metrics.verifiedAssertions,
      executionDigest,
    });
    validationRecorded = true;
  }
  const current = await deps.store.getVersion(input.id, input.version);
  return {
    workflow: { id: input.id, version: input.version, status: current.state.status },
    result,
    needsReexploration,
    ...(validate ? { validationRecorded } : {}),
  };
}

export const browserWorkflowList = defineTool({
  name: "browser_workflow_list",
  description: "按明确 URL 发现已启用的站点经验；不会启动或连接浏览器。优先使用已有平台专用方法。",
  input: BrowserWorkflowListInputSchema,
  output: z.object({
    workflows: z.array(
      z.object({
        id: z.string(),
        version: z.string(),
        name: z.string(),
        description: z.string(),
        appliesTo: z.object({ origins: z.array(z.string()), pathPrefix: z.string().optional() }),
        parameterSchema: z.record(z.unknown()),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
  execute: async (input) => ({
    workflows: await dependencies.store.listApplicableActive(input.url),
  }),
});

export const browserWorkflowSaveDraft = defineTool({
  name: "browser_workflow_save_draft",
  description:
    "将已探索的方法保存为不可变草稿；只编译、不执行，也不自动启用。不保存运行参数或页面内容。",
  input: BrowserWorkflowSaveDraftInputSchema,
  output: metadataSchema,
  execute: async (input) => {
    const parsed = BrowserWorkflowSaveDraftInputSchema.parse(input);
    if (parsed.draft.parameterSchema.type !== "object") {
      throw new StructuredToolError({
        code: "invalid_workflow",
        message: "Workflow parameters must use an object schema",
      });
    }
    const conditions = z.array(BrowserScriptConditionSchema).max(20);
    const draft = {
      ...parsed.draft,
      preconditions: conditions.parse(parsed.draft.preconditions),
      postconditions: conditions.min(1).parse(parsed.draft.postconditions),
    };
    const compilation = await dependencies.compile(draft.source);
    if (!compilation.valid) {
      throw new StructuredToolError({
        code: "invalid_workflow",
        message: "Workflow source failed compilation",
      });
    }
    return metadata(await dependencies.store.saveDraft(draft));
  },
});

export const browserWorkflowValidate = defineTool({
  name: "browser_workflow_validate",
  description:
    "在当前明确页面上实际执行指定版本，验证参数与结果断言；可能产生浏览器操作，遵守整段审批，不自动重复或启用。",
  input: BrowserWorkflowExecutionInputSchema,
  output: BrowserWorkflowExecutionOutputSchema,
  execute: async (input, ctx) =>
    await executeWorkflow(BrowserWorkflowExecutionInputSchema.parse(input), ctx, true),
});

export const browserWorkflowSetStatus = defineTool({
  name: "browser_workflow_set_status",
  description: "启用精确版本需成功验证记录和一次显式批准；停用立即生效。管理操作不需要浏览器。",
  input: BrowserWorkflowSetStatusInputSchema,
  output: metadataSchema,
  execute: async (input) => {
    const parsed = BrowserWorkflowSetStatusInputSchema.parse(input);
    const workflow = await dependencies.store.getVersion(parsed.id, parsed.version);
    if (parsed.status === "active") {
      await compiled(workflow);
      if (workflow.state.validations.length === 0) {
        throw new StructuredToolError({
          code: "workflow_unvalidated",
          message: "Validate this exact version successfully before enabling it",
        });
      }
      const subject = {
        tool: "browser_workflow_set_status",
        target: `${parsed.id}:${parsed.version}`,
        digest: createHash("sha256").update(`active:${parsed.id}:${parsed.version}`).digest("hex"),
        summary: `Enable ${workflow.draft.name} version ${parsed.version}`,
      };
      if (
        !parsed.toolActionApproval ||
        !approveToolAction({ approval: parsed.toolActionApproval, subject })
      ) {
        throw new StructuredToolError({
          code: "needs_confirmation",
          message: "Enabling a reusable workflow requires explicit approval for this exact version",
          details: {
            executionState: "not_executed",
            reason: "workflow_activation",
            approvalRequest: createToolActionApprovalRequest(subject, 300_000),
          },
        });
      }
    }
    await dependencies.store.setStatus(parsed.id, parsed.version, parsed.status);
    return metadata(await dependencies.store.getVersion(parsed.id, parsed.version));
  },
});

export const browserWorkflowRun = defineTool({
  name: "browser_workflow_run",
  description:
    "执行已显式启用且适用于当前页面的精确站点经验版本；失败返回部分进度，需要重新探索时暂停推荐。",
  input: BrowserWorkflowExecutionInputSchema,
  output: BrowserWorkflowExecutionOutputSchema,
  execute: async (input, ctx) =>
    await executeWorkflow(BrowserWorkflowExecutionInputSchema.parse(input), ctx, false),
});
