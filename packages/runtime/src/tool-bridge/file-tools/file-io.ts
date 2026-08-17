import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";

const UTF8_BOM = "\uFEFF";
const BINARY_PROBE_BYTES = 8192;

export const FILE_CONTAINMENT_DRIFT_MESSAGE =
  "文件路径的安全条件在准入后发生变化，已在执行前阻止；请重新提交以重新确认";

export type LoadFileFailure = {
  readonly ok: false;
  readonly code: "not-found" | "is-directory" | "not-regular-file" | "too-large" | "binary";
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

export interface FilePathAdmission {
  readonly admittedExternal: boolean;
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

export function canonicalResourcePath(path: string): string {
  const resolved = resolveContainmentPath(path);
  return resolved.ok ? resolved.path : path;
}

function isContainedRel(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type ContainmentResolution = { readonly ok: true; readonly path: string } | { readonly ok: false };

function resolveContainmentPath(path: string): ContainmentResolution {
  let ancestor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = realpathSync.native(ancestor);
      return { ok: true, path: resolve(canonicalAncestor, ...[...suffix].reverse()) };
    } catch {
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          return { ok: false };
        }
      } catch {
        // Not a symlink (or lstat failed); walk to the parent.
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return { ok: false };
      }
      suffix.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

export function escapesWorkdir(workdir: string, path: string): boolean {
  let canonicalWorkdir: string;
  try {
    canonicalWorkdir = realpathSync.native(workdir);
  } catch {
    return true;
  }
  const resolved = resolveContainmentPath(resolveFilePath(workdir, path));
  if (!resolved.ok) {
    return true;
  }
  return !isContainedRel(relative(canonicalWorkdir, resolved.path));
}

export function formatPathForApproval(workdir: string, inputPath: string): string {
  const resolved = resolveFilePath(workdir, inputPath);
  if (escapesWorkdir(workdir, inputPath)) {
    const target = resolveContainmentPath(resolved);
    return `${target.ok ? target.path : resolved}（工作目录外）`;
  }
  let base = workdir;
  try {
    base = realpathSync.native(workdir);
  } catch {
    // Keep the configured workdir when it cannot be canonicalized.
  }
  const target = resolveContainmentPath(resolved);
  const rel = relative(base, target.ok ? target.path : resolved);
  return rel === "" ? "." : rel;
}

export function captureFilePathAdmission(workdir: string, inputPath: string): FilePathAdmission {
  return { admittedExternal: escapesWorkdir(workdir, inputPath) };
}

function isFilePathAdmission(value: unknown): value is FilePathAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    "admittedExternal" in value &&
    typeof (value as { admittedExternal: unknown }).admittedExternal === "boolean"
  );
}

export function revalidateFilePathAdmission(
  workdir: string,
  inputPath: string,
  captured: unknown,
): NormalizedToolResult | undefined {
  if (!isFilePathAdmission(captured) || captured.admittedExternal) {
    return undefined;
  }
  if (!escapesWorkdir(workdir, inputPath)) {
    return undefined;
  }
  return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, FILE_CONTAINMENT_DRIFT_MESSAGE);
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
    if (!stats.isFile()) {
      return {
        ok: false,
        code: "not-regular-file",
        message: `${path} 不是普通文件，文件工具仅支持常规文本文件`,
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
