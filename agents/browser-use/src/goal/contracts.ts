import { z } from "zod";
import { FormTaskSchema } from "./form-context.ts";
import { ExecutionSummarySchema } from "./execution-context.ts";
import { ReadTaskSchema, TaskProgressSchema } from "./task-progress.ts";
import { BrowserActionApprovalSchema } from "@roll-agent/browser";

export const TaskAssistantPurposeSchema = z.enum([
  "preflight",
  "resolve_value",
  "resolve_batch",
  "validate_value",
  "validate_batch",
  "review_field",
  "review",
  "clarify",
]);
export const ResolvedTaskValueSchema = z.object({
  text: z.string().max(8000),
  source: z.enum(["supplied", "derived", "generated", "selected"]),
  sourceIds: z.array(z.string()),
  evidence: z.string(),
});
export type ResolvedTaskValue = z.infer<typeof ResolvedTaskValueSchema>;

export const BrowserOperateInputSchema = z.object({
  pageId: z.string().min(1),
  goal: z
    .string()
    .min(1)
    .max(16000)
    .describe(
      "原样传递用户目标；不要总结或重排其中要求原样复制的文字。局部修正可追加说明，但保留原始约束。",
    ),
  formTask: FormTaskSchema.optional().describe(
    "本次表单委派的创建/编辑意图、可设置字段和只读保留字段。set引用values中唯一valueName；不规划跨调用业务任务。不能与readTask同时使用。",
  ),
  readTask: ReadTaskSchema.optional().describe(
    "单次调用内的读取/返回约定。读取详情后关闭返回时填写；输出是需要读取的资料名，不是待填表单值。普通填表省略。",
  ),
  values: z
    .array(z.object({ name: z.string().min(1).max(200), text: z.string().max(8000) }))
    .max(64)
    .default([]),
  delegatedDecisions: z
    .array(z.string().min(1).max(2000))
    .max(32)
    .default([])
    .describe("用户明确授权 Agent 自行决定的事项；也可直接在 goal 中表述。不是新增事实。"),
  maxTextCalls: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(0)
    .describe("兼容旧调用方，已不使用。task 循环不调用宿主文本助手。"),
  maxRecoveryDecisions: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe("兼容旧调用方，已不使用。停滞返回 Roll，不在循环内调用宿主恢复。"),
  allowedOrigins: z
    .array(
      z
        .string()
        .url()
        .refine((url) => new URL(url).origin === url, "Expected an exact origin"),
    )
    .min(1)
    .max(16),
  blockedNames: z
    .array(z.string().min(1).max(200))
    .max(64)
    .default([])
    .describe("禁止操作的控件名称片段，例如最终提交按钮。"),
  engine: z.enum(["jev", "sampling"]).default("jev"),
  strategy: z
    .enum(["task", "fields"])
    .default("task")
    .describe(
      "task 由所选引擎根据目标、必填信息及依赖选择动作和已有资料，不调用宿主助手；fields 按完整资料逐项推进。",
    ),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Jev 使用 TypeSafe 官方接口和 TYPESAFE_API_KEY，默认 jev-latest（可固定 jev-1.13.0）；sampling 仅用于显式对照，使用宿主配置。",
    ),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe(
      "包含观察后的无动作判断及多级菜单交互，不是字段数。一般保留默认50；完整复杂表单可用100。不要因只修正少数字段而降到4或5。",
    ),
  timeoutMs: z.number().int().min(1000).max(1200000).default(300000),
  browserActionApproval: BrowserActionApprovalSchema.optional(),
});
export type BrowserOperateInput = z.infer<typeof BrowserOperateInputSchema>;

export const BrowserOperateOutputSchema = z.object({
  status: z.enum([
    "model_done",
    "interaction_done",
    "needs_input",
    "needs_reasoning",
    "blocked",
    "step_limit",
    "failed",
    "cancelled",
  ]),
  verified: z.literal(false),
  progress: TaskProgressSchema.optional(),
  execution: ExecutionSummarySchema.optional(),
  elapsedMs: z.number(),
  steps: z.array(
    z.object({
      step: z.number(),
      observationMs: z.number(),
      decisionMs: z.number(),
      decisionAttempts: z.number().int().positive().optional(),
      actionMs: z.number(),
      textMs: z.number().optional(),
      recovery: z.boolean().optional(),
      distributions: z
        .record(
          z.object({ probabilities: z.record(z.number()), confidence: z.number().optional() }),
        )
        .optional(),
      operation: z.string(),
      requirement: z.string().optional(),
      target: z.string().optional(),
      valueName: z.string().optional(),
      executed: z.boolean(),
      error: z.string().optional(),
      requestedModel: z.string(),
      resolvedModel: z.string(),
      provider: z.string(),
      usage: z
        .object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          cost: z.number().optional(),
        })
        .optional(),
    }),
  ),
  error: z.string().optional(),
  question: z.string().optional(),
  recoveryDecisions: z.number().int().nonnegative().optional(),
  fieldEvidence: z
    .array(
      z.object({
        field: z.string(),
        instruction: z.string(),
        expected: z.string().optional(),
        current: z.string().optional(),
        status: z.enum(["pending", "applied", "preserved"]),
        source: z.string().optional(),
        targetKey: z.string(),
      }),
    )
    .optional(),
  pendingRequirements: z.array(z.string()).optional(),
  finalObservation: z.unknown().optional(),
  resolvedValues: z
    .array(ResolvedTaskValueSchema.extend({ field: z.string(), targetKey: z.string().optional() }))
    .optional(),
  textCalls: z
    .array(
      z.object({
        purpose: TaskAssistantPurposeSchema,
        elapsedMs: z.number(),
        cached: z.boolean(),
        startedAtMs: z.number().optional(),
        endedAtMs: z.number().optional(),
        modelCalls: z
          .array(
            z.object({
              provider: z.string(),
              requestedModel: z.string(),
              resolvedModel: z.string(),
              elapsedMs: z.number(),
              fallback: z.boolean().optional(),
              error: z.string().optional(),
              usage: z
                .object({
                  inputTokens: z.number().optional(),
                  outputTokens: z.number().optional(),
                  cost: z.number().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type BrowserOperateOutput = z.infer<typeof BrowserOperateOutputSchema>;
