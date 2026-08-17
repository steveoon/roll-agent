import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";

const BS = String.fromCharCode(0x5c);
const DOUBLE_QUOTE = String.fromCharCode(0x22);
const SINGLE_EXAMPLE = BS + "u0000";
const DOUBLE_EXAMPLE = BS + BS + "u0000";
const JSON_SNIPPET = `{"content": ${DOUBLE_QUOTE}${DOUBLE_EXAMPLE}${DOUBLE_QUOTE}}`;

/**
 * Raw control characters that must never appear in text-file payloads:
 * C0 controls except TAB/LF/CR, plus DEL.
 *
 * This is the single source of truth shared by the read side (binary probe in
 * file-io.ts) and the write side (payload rejection here), so the file tools
 * stay a self-consistent state-sync protocol: anything a write refuses is also
 * something a read would refuse to hand back.
 *
 * Intentionally NOT covered: C1 controls (U+0080-U+009F) and invisible
 * zero-width characters. They can have legitimate uses (ZWJ emoji sequences,
 * formatting marks) and round-trip consistently through read and write, so
 * rejecting them would cause false refusals without closing a protocol hole.
 *
 * The implementation compares code points numerically on purpose: this module
 * must never contain raw control bytes itself. Tool parameters arrive as
 * JSON-decoded strings, so a literal escape such as backslash-u0000 typed by
 * the model is already a raw NUL by the time it gets here.
 */
export function isRawControlCode(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}

export interface RawControlCharFinding {
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly code: number;
}

export function findRawControlChar(text: string): RawControlCharFinding | undefined {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      lineStart = index + 1;
      continue;
    }
    if (isRawControlCode(code)) {
      return { index, line, column: index - lineStart + 1, code };
    }
  }
  return undefined;
}

export function formatControlCharCode(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function describeRawControlCharRejection(
  fieldLabel: string,
  finding: RawControlCharFinding,
): string {
  return [
    `${fieldLabel}含原始控制字符 ${formatControlCharCode(finding.code)}（第 ${String(finding.line)} 行第 ${String(finding.column)} 列），文件工具只支持文本内容，已拒绝执行，未写入任何内容。`,
    `常见原因：JSON 参数里的转义会被解码成真实控制字符——参数中写 ${SINGLE_EXAMPLE}（6 个字符），解码后是 1 个 NUL 字节。`,
    `两种正确的做法：(1) 若要在文件中保留转义序列文本（如源码里的 ${SINGLE_EXAMPLE}），JSON 参数请写 ${DOUBLE_EXAMPLE}，例如 ${JSON_SNIPPET}，解码后是 6 个 ASCII 字符；(2) 若确实需要写入原始控制字节，请改用 shell 命令生成该字节（如 printf 或 node 脚本），文件工具不支持。`,
  ].join("\n");
}

export function rejectTextWithRawControlChars(
  fieldLabel: string,
  text: string,
): NormalizedToolResult | undefined {
  const finding = findRawControlChar(text);
  if (finding === undefined) {
    return undefined;
  }
  return failedToolResult(
    TOOL_OUTCOME_KINDS.invalidInput,
    describeRawControlCharRejection(fieldLabel, finding),
  );
}
