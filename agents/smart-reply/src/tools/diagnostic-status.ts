import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  collectEffectiveEnvSources,
  EffectiveEnvSourcesSchema,
  SMART_REPLY_DECLARED_ENV_KEYS,
} from "../diagnostics/effective-env.ts";

const DiagnosticStatusSchema = z.object({
  effectiveEnvSources: EffectiveEnvSourcesSchema,
});

export const diagnosticStatus = defineTool({
  name: "diagnostic_status",
  description: "返回 smart-reply 运行态进程中已声明环境变量的存在状态与短指纹",
  input: z.object({}),
  output: DiagnosticStatusSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Querying smart-reply diagnostic status");

    return {
      effectiveEnvSources: collectEffectiveEnvSources(SMART_REPLY_DECLARED_ENV_KEYS),
    };
  },
});
