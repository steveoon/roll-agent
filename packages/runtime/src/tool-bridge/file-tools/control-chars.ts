import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";

export const RAW_NUL_LABEL = "U+0000";

const SINGLE_EXAMPLE = "\\u0000";
const DOUBLE_EXAMPLE = "\\\\u0000";
const JSON_SNIPPET = `{"content": "${DOUBLE_EXAMPLE}"}`;

export interface RawNulFinding {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

export function findRawNul(text: string): RawNulFinding | undefined {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      lineStart = index + 1;
      continue;
    }
    if (code === 0x00) {
      return { index, line, column: index - lineStart + 1 };
    }
  }
  return undefined;
}

export function describeRawNulRejection(fieldLabel: string, finding: RawNulFinding): string {
  return [
    `${fieldLabel}含原始 NUL 字符 ${RAW_NUL_LABEL}（第 ${String(finding.line)} 行第 ${String(finding.column)} 列），文件工具只支持文本内容，已拒绝执行，未写入任何内容。`,
    `常见原因：JSON 参数里的转义会被解码成真实字符——参数中写 ${SINGLE_EXAMPLE}（6 个字符），解码后是 1 个 NUL 字节。`,
    `两种正确的做法：(1) 若要在文件中保留转义序列文本（如源码里的 ${SINGLE_EXAMPLE}），JSON 参数请写 ${DOUBLE_EXAMPLE}，例如 ${JSON_SNIPPET}，解码后是 6 个 ASCII 字符；(2) 若确实需要写入原始 NUL 字节，请改用 shell 命令生成该字节（如 printf 或 node 脚本），文件工具不支持。`,
  ].join("\n");
}

export function describeLoneSurrogateRejection(fieldLabel: string): string {
  return `${fieldLabel}含不成对的 UTF-16 代理项（lone surrogate），无法作为 UTF-8 文本原样写入，已拒绝执行，未写入任何内容。请检查 JSON 参数中的 \\uD800-\\uDFFF 转义是否成对。`;
}

export function rejectInvalidTextPayload(
  fieldLabel: string,
  text: string,
): NormalizedToolResult | undefined {
  const finding = findRawNul(text);
  if (finding !== undefined) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      describeRawNulRejection(fieldLabel, finding),
    );
  }
  if (!text.isWellFormed()) {
    return failedToolResult(
      TOOL_OUTCOME_KINDS.invalidInput,
      describeLoneSurrogateRejection(fieldLabel),
    );
  }
  return undefined;
}
