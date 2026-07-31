import { APPROVAL_EXPLANATION_MAX_CHARS } from "@roll-agent/protocol";
import { z } from "zod";

export const shellCommandExplanationSchema = z
  .string()
  .trim()
  .min(1)
  .max(APPROVAL_EXPLANATION_MAX_CHARS)
  .describe(
    "面向非技术用户，使用用户当前语言，用一句话说明命令会做什么以及为何有助于当前任务。建议 40-60 字符，最多 100 字符；不要复述命令、声称命令安全或包含敏感值",
  );
