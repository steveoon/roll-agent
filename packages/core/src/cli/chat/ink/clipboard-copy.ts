import type { HistoryItem } from "./state.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BACKSLASH = String.fromCharCode(92);

export const COPY_PROMO_FOOTER = "---\n对话来自 roll-agent · npm i -g @roll-agent/core";

export function lastRoundCopyText(history: readonly HistoryItem[]): string | undefined {
  const lastUserIndex = history.findLastIndex((item) => item.kind === "user");
  const userItem = history[lastUserIndex];
  if (userItem?.kind !== "user") {
    return undefined;
  }
  const assistantTexts = history
    .slice(lastUserIndex + 1)
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text)
    .filter((text) => text.length > 0);
  const parts = [`用户: ${userItem.text}`];
  if (assistantTexts.length > 0) {
    parts.push(`助手: ${assistantTexts.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

export function buildOsc52(text: string): string {
  return `${ESC}]52;c;${Buffer.from(text, "utf8").toString("base64")}${BEL}`;
}

export function wrapTmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}${BACKSLASH}`;
}

interface ClipboardStdout {
  write(chunk: string): unknown;
}

async function writePbcopy(text: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn("pbcopy", { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export async function copyTextToClipboard(
  text: string,
  stdout: ClipboardStdout,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    const osc = buildOsc52(text);
    stdout.write(env["TMUX"] !== undefined ? wrapTmuxPassthrough(osc) : osc);
    await writePbcopy(text);
    return true;
  } catch {
    return false;
  }
}
