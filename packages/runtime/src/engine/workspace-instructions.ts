import { readFileSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKSPACE_INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 32_000;
export const WORKSPACE_INSTRUCTIONS_MODES = { auto: "auto", off: "off" } as const;

export type WorkspaceInstructionsMode =
  (typeof WORKSPACE_INSTRUCTIONS_MODES)[keyof typeof WORKSPACE_INSTRUCTIONS_MODES];

export interface WorkspaceInstructions {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

export type WorkspaceInstructionsSetting =
  | { readonly kind: typeof WORKSPACE_INSTRUCTIONS_MODES.auto }
  | { readonly kind: typeof WORKSPACE_INSTRUCTIONS_MODES.off }
  | { readonly kind: "path"; readonly path: string };

export interface WorkspaceInstructionsSource {
  current(): WorkspaceInstructions | undefined;
}

export interface CreateWorkspaceInstructionsSourceOptions {
  readonly cwd: string;
  readonly setting: WorkspaceInstructionsSetting;
  readonly maxChars?: number;
  readonly onIssue?: (message: string) => void;
}

interface CachedWorkspaceInstructions {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: WorkspaceInstructions | undefined;
}

export function parseWorkspaceInstructionsSetting(
  value: string,
  cwd: string,
): WorkspaceInstructionsSetting {
  const trimmed = value.trim();
  if (trimmed === WORKSPACE_INSTRUCTIONS_MODES.auto) {
    return { kind: WORKSPACE_INSTRUCTIONS_MODES.auto };
  }
  if (trimmed === WORKSPACE_INSTRUCTIONS_MODES.off) {
    return { kind: WORKSPACE_INSTRUCTIONS_MODES.off };
  }
  return { kind: "path", path: resolve(cwd, trimmed) };
}

function statFile(path: string): Stats | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

export function findWorkspaceInstructionsPath(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    for (const name of WORKSPACE_INSTRUCTION_FILE_NAMES) {
      const candidate = join(dir, name);
      if (statFile(candidate) !== undefined) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkspaceInstructions(
  path: string,
  raw: string,
  maxChars: number,
): WorkspaceInstructions | undefined {
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }
  if (text.length <= maxChars) {
    return { path, content: text, truncated: false, totalChars: text.length };
  }
  return { path, content: text.slice(0, maxChars), truncated: true, totalChars: text.length };
}

export function createWorkspaceInstructionsSource(
  options: CreateWorkspaceInstructionsSourceOptions,
): WorkspaceInstructionsSource {
  const maxChars = options.maxChars ?? WORKSPACE_INSTRUCTIONS_MAX_CHARS;
  const reported = new Set<string>();
  let cached: CachedWorkspaceInstructions | undefined;

  const report = (key: string, message: string): void => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    options.onIssue?.(message);
  };

  const resolvePath = (): string | undefined => {
    switch (options.setting.kind) {
      case WORKSPACE_INSTRUCTIONS_MODES.off:
        return undefined;
      case "path":
        return options.setting.path;
      default:
        return findWorkspaceInstructionsPath(options.cwd);
    }
  };

  return {
    current(): WorkspaceInstructions | undefined {
      const path = resolvePath();
      if (path === undefined) {
        cached = undefined;
        return undefined;
      }
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch (error) {
        cached = undefined;
        if (options.setting.kind === "path") {
          const message = errorText(error);
          report(
            `missing:${path}:${message}`,
            `chat.instructions 指向的文件不可读：${path}（${message}）`,
          );
        }
        return undefined;
      }
      if (!stats.isFile()) {
        cached = undefined;
        if (options.setting.kind === "path") {
          report(`not-file:${path}`, `chat.instructions 指向的路径不是文件：${path}`);
        }
        return undefined;
      }
      if (
        cached !== undefined &&
        cached.path === path &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return cached.value;
      }
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        cached = undefined;
        const message = errorText(error);
        report(`read:${path}:${message}`, `工作区约定 ${path} 读取失败：${message}`);
        return undefined;
      }
      const value = buildWorkspaceInstructions(path, raw, maxChars);
      if (value?.truncated === true) {
        report(
          `truncated:${path}:${String(stats.mtimeMs)}`,
          `工作区约定 ${path} 共 ${String(value.totalChars)} 字符，超过上限 ${String(maxChars)}，仅注入前 ${String(maxChars)} 字符，请精简该文件`,
        );
      }
      cached = { path, mtimeMs: stats.mtimeMs, size: stats.size, value };
      return value;
    },
  };
}
