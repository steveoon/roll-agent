import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const UTF8_BOM = "\uFEFF";
const BINARY_PROBE_BYTES = 8192;

export type LoadFileFailure = {
  readonly ok: false;
  readonly code: "not-found" | "is-directory" | "too-large" | "binary";
  readonly message: string;
};

export interface LoadedTextFile {
  readonly ok: true;
  readonly path: string;
  readonly key: string;
  readonly content: string;
  readonly hadBom: boolean;
  readonly suspectEncoding: boolean;
}

export function resolveFilePath(workdir: string, input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(workdir, input);
}

export function canonicalFileKey(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function escapesWorkdir(workdir: string, path: string): boolean {
  const canonicalWorkdir = canonicalFileKey(workdir);
  const canonicalPath = canonicalFileKey(resolveFilePath(workdir, path));
  const rel = relative(canonicalWorkdir, canonicalPath);
  return rel.startsWith("..") || isAbsolute(rel);
}

function looksBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

export function loadTextFile(
  path: string,
  limits: { readonly maxFileBytes: number },
): LoadedTextFile | LoadFileFailure {
  let size: number;
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return {
        ok: false,
        code: "is-directory",
        message: `${path} 是目录，浏览目录请用 roll__list_dir`,
      };
    }
    size = stats.size;
  } catch {
    return { ok: false, code: "not-found", message: `文件不存在: ${path}` };
  }
  if (size > limits.maxFileBytes) {
    return {
      ok: false,
      code: "too-large",
      message: `文件过大（${String(size)} 字节，上限 ${String(limits.maxFileBytes)} 字节），文件工具仅支持文本文件`,
    };
  }
  const buffer = readFileSync(path);
  if (looksBinary(buffer)) {
    return { ok: false, code: "binary", message: `${path} 是二进制文件，文件工具仅支持文本` };
  }
  const raw = buffer.toString("utf8");
  const hadBom = raw.startsWith(UTF8_BOM);
  const content = hadBom ? raw.slice(UTF8_BOM.length) : raw;
  return {
    ok: true,
    path,
    key: canonicalFileKey(path),
    content,
    hadBom,
    suspectEncoding: content.includes("�"),
  };
}

export function saveTextFile(path: string, content: string, hadBom: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hadBom ? `${UTF8_BOM}${content}` : content, "utf8");
}
