import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSource, AgentSourceType, RegisteredAgent } from "../types/agent.ts";

const SKILL_FILE_NAME = "SKILL.md";

/** 推断 Agent 来源类型，兼容旧 store 数据。 */
export function inferAgentSourceType(agent: RegisteredAgent): AgentSourceType {
  if (agent.source) {
    return agent.source.type;
  }

  return inferAgentSourceFromInstallPath(agent.installPath, agent.transport)?.type ?? "local-path";
}

/** 适合展示到 CLI 的来源标签。 */
export function formatAgentSourceType(sourceType: AgentSourceType): string {
  switch (sourceType) {
    case "git":
      return "git";
    case "installed-package":
      return "installed";
    case "remote-manifest":
      return "remote";
    case "local-path":
      return "local-path";
  }
}

/** 展示 Agent 的主要位置：stdio 为本地路径，HTTP 为 endpoint。 */
export function getAgentLocation(agent: RegisteredAgent): string {
  return agent.transport.type === "streamable-http" ? agent.transport.endpoint : agent.installPath;
}

/** 根据本地 installPath 尝试推断来源类型。 */
export function inferAgentSourceFromInstallPath(
  installPath: string,
  transport: RegisteredAgent["transport"],
): AgentSource | undefined {
  if (existsSync(resolve(installPath, ".git"))) {
    const originUrl = readGitOriginUrl(installPath);
    return originUrl ? { type: "git", url: originUrl } : { type: "git" };
  }

  if (existsSync(resolve(installPath, SKILL_FILE_NAME))) {
    return { type: "local-path", path: installPath };
  }

  if (transport.type === "streamable-http") {
    return { type: "remote-manifest", endpoint: transport.endpoint };
  }

  return undefined;
}

function readGitOriginUrl(installPath: string): string | undefined {
  const gitConfigPath = resolve(installPath, ".git", "config");
  if (!existsSync(gitConfigPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(gitConfigPath, "utf-8");
    const remoteOriginBlock = content.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
    const urlMatch = remoteOriginBlock?.[1]?.match(/^\s*url\s*=\s*(.+)$/m);
    return urlMatch?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** 将包名/标识符转换为适合落盘的目录名。 */
export function sanitizeInstallId(input: string): string {
  const sanitized = input
    .trim()
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return sanitized.length > 0 ? sanitized : "agent";
}

/** 从 npm package spec 中提取包名。 */
export function parsePackageName(packageSpec: string): string {
  if (packageSpec.startsWith("@")) {
    const scopeSeparator = packageSpec.indexOf("/");
    if (scopeSeparator === -1) {
      return packageSpec;
    }

    const versionSeparator = packageSpec.indexOf("@", scopeSeparator + 1);
    return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
  }

  const versionSeparator = packageSpec.indexOf("@");
  return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

/** 计算 `npm install --prefix` 后包在 node_modules 中的根目录。 */
export function resolveInstalledPackageRoot(installDir: string, packageName: string): string {
  return resolve(installDir, "node_modules", ...packageName.split("/"));
}
