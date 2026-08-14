import { execFile } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RgRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly truncated: boolean;
  readonly errorMessage?: string;
}

export function runRg(
  args: readonly string[],
  cwd: string,
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
): Promise<RgRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    execFile(
      rgPath,
      [...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: maxOutputBytes * 2,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const isBufferOverflow = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (error && !isBufferOverflow && typeof error.code === "number" && error.code > 1) {
          resolve({
            ok: false,
            stdout: "",
            truncated: false,
            errorMessage: stderr.trim() || error.message,
          });
          return;
        }
        if (error && !isBufferOverflow && typeof error.code !== "number") {
          resolve({ ok: false, stdout: "", truncated: false, errorMessage: error.message });
          return;
        }
        const raw = stdout;
        if (Buffer.byteLength(raw, "utf8") > maxOutputBytes) {
          const clipped = Buffer.from(raw, "utf8").subarray(0, maxOutputBytes).toString("utf8");
          const lastNewline = clipped.lastIndexOf("\n");
          resolve({
            ok: true,
            stdout: lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped,
            truncated: true,
          });
          return;
        }
        resolve({ ok: true, stdout: raw, truncated: false });
      },
    );
  });
}
