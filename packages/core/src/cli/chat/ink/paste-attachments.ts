import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface PendingChatAttachment {
  readonly name: string;
  readonly path: string;
  readonly sizeLabel: string;
  readonly data: string;
  readonly mediaType: string;
}

export type AttachmentLoadFailure = {
  readonly ok: false;
  readonly path: string;
  readonly message: string;
};

export type AttachmentLoadResult =
  | { readonly ok: true; readonly attachment: PendingChatAttachment }
  | AttachmentLoadFailure;

function tokenizePastedText(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1] as string;
      index += 2;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function expandPathToken(token: string): string | undefined {
  if (token.startsWith("file://")) {
    try {
      return fileURLToPath(token);
    } catch {
      return undefined;
    }
  }
  if (token === "~") {
    return homedir();
  }
  if (token.startsWith("~/")) {
    return resolve(homedir(), token.slice(2));
  }
  return isAbsolute(token) ? token : resolve(token);
}

function imageMediaTypeOf(path: string): string | undefined {
  const extension = extname(path).slice(1).toLowerCase();
  return IMAGE_MEDIA_TYPES[extension];
}

export function parsePastedImagePaths(text: string): string[] | undefined {
  const tokens = tokenizePastedText(text);
  if (tokens.length === 0) {
    return undefined;
  }
  const paths: string[] = [];
  for (const token of tokens) {
    const expanded = expandPathToken(token);
    if (expanded === undefined || imageMediaTypeOf(expanded) === undefined) {
      return undefined;
    }
    paths.push(expanded);
  }
  return paths;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.round(bytes / 1024))}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function loadPendingAttachment(path: string): AttachmentLoadResult {
  const mediaType = imageMediaTypeOf(path);
  if (mediaType === undefined) {
    return { ok: false, path, message: `不支持的图像格式: ${basename(path)}` };
  }
  let bytes: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return { ok: false, path, message: `不是文件: ${basename(path)}` };
    }
    bytes = stats.size;
  } catch {
    return { ok: false, path, message: `文件不存在或不可读: ${basename(path)}` };
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      path,
      message: `图片 ${basename(path)} 超过 ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} 上限（实际 ${formatAttachmentSize(bytes)}）`,
    };
  }
  try {
    const data = readFileSync(path).toString("base64");
    return {
      ok: true,
      attachment: {
        name: basename(path),
        path,
        sizeLabel: formatAttachmentSize(bytes),
        data,
        mediaType,
      },
    };
  } catch {
    return { ok: false, path, message: `读取失败: ${basename(path)}` };
  }
}

export function attachmentExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
