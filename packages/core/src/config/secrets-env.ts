import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretsEnv {
  readonly path: string;
  readonly variables: Readonly<Record<string, string>>;
}

export function defaultSecretsEnvPath(homeDir: string = homedir()): string {
  return join(homeDir, ".roll-agent", "secrets.env");
}

/**
 * 解析 secrets.env 文本。仅支持 `KEY=VALUE` 行；忽略注释与空行；
 * 去除成对的双引号/单引号；值中的 `${...}` 按字面量保留，不递归展开。
 */
export function parseSecretsEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadSecretsEnv(path: string = defaultSecretsEnvPath()): SecretsEnv | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { path, variables: parseSecretsEnvText(text) };
}

export interface SecretsFilePermission {
  readonly exists: boolean;
  /** 文件存在时给出是否仅属主可读写；无法 stat 时为 undefined */
  readonly isPrivate: boolean | undefined;
}

export function inspectSecretsFilePermission(path: string): SecretsFilePermission {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { exists: false, isPrivate: undefined };
  }
  return { exists: true, isPrivate: (mode & 0o077) === 0 };
}
