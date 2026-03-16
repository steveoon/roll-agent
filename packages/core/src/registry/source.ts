import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSourceType, RegisteredAgent } from "../types/agent.ts";

/** 推断 Agent 来源类型，兼容旧 store 数据。 */
export function inferAgentSourceType(agent: RegisteredAgent): AgentSourceType {
  if (agent.source) {
    return agent.source.type;
  }

  if (agent.transport.type === "streamable-http") {
    return "remote";
  }

  if (existsSync(resolve(agent.installPath, ".git"))) {
    return "git";
  }

  return "local";
}

/** 适合展示到 CLI 的来源标签。 */
export function formatAgentSourceType(sourceType: AgentSourceType): string {
  switch (sourceType) {
    case "git":
      return "git";
    case "installed":
      return "installed";
    case "remote":
      return "remote";
    case "local":
      return "local-path";
  }
}

/** 展示 Agent 的主要位置：stdio 为本地路径，HTTP 为 endpoint。 */
export function getAgentLocation(agent: RegisteredAgent): string {
  return agent.transport.type === "streamable-http" ? agent.transport.endpoint : agent.installPath;
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
