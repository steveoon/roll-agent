import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLIPBOARD_SCRIPT = `try
	if (count of (clipboard info for «class furl»)) > 0 then
		return "FILE:" & POSIX path of (the clipboard as «class furl»)
	end if
end try
try
	return the clipboard as «class PNGf»
on error
	return "NONE"
end try`;

const PNG_DATA_PREFIX = "«data PNGf";
const OSASCRIPT_TIMEOUT_MS = 10_000;
const OSASCRIPT_MAX_BUFFER = 64 * 1024 * 1024;

export type ClipboardImageResult =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "image"; readonly data: string; readonly mediaType: "image/png" }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string };

export function parseClipboardScriptOutput(stdout: string): ClipboardImageResult {
  const output = stdout.trim();
  if (output.startsWith("FILE:")) {
    const path = output.slice("FILE:".length).trim();
    return path.length > 0 && isAbsolute(path) ? { kind: "file", path } : { kind: "none" };
  }
  if (output.startsWith(PNG_DATA_PREFIX) && output.endsWith("»")) {
    const hex = output.slice(PNG_DATA_PREFIX.length, -1);
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(hex)) {
      return { kind: "error", message: "剪贴板图像数据无法解析" };
    }
    return {
      kind: "image",
      data: Buffer.from(hex, "hex").toString("base64"),
      mediaType: "image/png",
    };
  }
  return { kind: "none" };
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (process.platform !== "darwin") {
    return { kind: "unsupported" };
  }
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", CLIPBOARD_SCRIPT], {
      timeout: OSASCRIPT_TIMEOUT_MS,
      maxBuffer: OSASCRIPT_MAX_BUFFER,
    });
    return parseClipboardScriptOutput(stdout);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
