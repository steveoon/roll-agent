import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  TOOL_OUTCOME_KINDS,
  failedToolResult,
  type NormalizedToolResult,
} from "../normalize-result.ts";
import { RAW_NUL_LABEL } from "./control-chars.ts";

const UTF8_BOM = "\uFEFF";

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
  readonly admittedTarget: string | undefined;
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

function admittedTargetOf(workdir: string, inputPath: string): string | undefined {
  const target = resolveContainmentPath(resolveFilePath(workdir, inputPath));
  return target.ok ? target.path : undefined;
}

export function captureFilePathAdmission(workdir: string, inputPath: string): FilePathAdmission {
  return {
    admittedExternal: escapesWorkdir(workdir, inputPath),
    admittedTarget: admittedTargetOf(workdir, inputPath),
  };
}

function isFilePathAdmission(value: unknown): value is FilePathAdmission {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { admittedExternal?: unknown; admittedTarget?: unknown };
  return (
    typeof candidate.admittedExternal === "boolean" &&
    (candidate.admittedTarget === undefined || typeof candidate.admittedTarget === "string")
  );
}

export function revalidateFilePathAdmission(
  workdir: string,
  inputPath: string,
  captured: unknown,
): NormalizedToolResult | undefined {
  if (!isFilePathAdmission(captured)) {
    return undefined;
  }
  const escapedNow = escapesWorkdir(workdir, inputPath);
  const targetNow = admittedTargetOf(workdir, inputPath);
  const containmentDrift = !captured.admittedExternal && escapedNow;
  const targetDrift = captured.admittedTarget !== targetNow;
  return containmentDrift || targetDrift
    ? failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, FILE_CONTAINMENT_DRIFT_MESSAGE)
    : undefined;
}

function containsRawNul(buffer: Buffer): boolean {
  return buffer.indexOf(0x00) !== -1;
}

export interface BomSplitText {
  readonly content: string;
  readonly hadBom: boolean;
}

export function splitUtf8Bom(raw: string): BomSplitText {
  const hadBom = raw.startsWith(UTF8_BOM);
  return { content: hadBom ? raw.slice(UTF8_BOM.length) : raw, hadBom };
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
  if (containsRawNul(buffer)) {
    return {
      ok: false,
      code: "binary",
      message: `${path} 是二进制文件（含原始 NUL 字节 ${RAW_NUL_LABEL}），文件工具仅支持文本。若确实需要处理该文件，请用 shell 命令。`,
    };
  }
  const { content, hadBom } = splitUtf8Bom(buffer.toString("utf8"));
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
