import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { applySchedulerConfigEnv, prependExecDirToPath } from "./exec-env.ts";

const WINDOWS_COMMAND_SUFFIXES = ["", ".exe", ".cmd", ".bat"] as const;

export interface ScheduledEffectivePathInput {
  readonly baselinePath: string;
  readonly execPath: string;
  readonly schedulerEnv: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}

/**
 * 模拟 schedule-exec 修复后的有效 PATH：基线 PATH → 前置当前 node 目录 →
 * 应用 scheduler.env（用户声明 PATH 则覆盖）。与 exec 侧共用同一组组装函数，
 * 保证诊断与实际运行环境不漂移。
 */
export function buildScheduledEffectivePath(input: ScheduledEffectivePathInput): string {
  const key = input.platform === "win32" ? "Path" : "PATH";
  const simulated: NodeJS.ProcessEnv = { [key]: input.baselinePath };
  prependExecDirToPath(simulated, input.execPath, input.platform);
  applySchedulerConfigEnv(simulated, input.schedulerEnv);
  return simulated[input.platform === "win32" ? resolveSimulatedKey(simulated) : "PATH"] ?? "";
}

function resolveSimulatedKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

export function isCommandReachable(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const suffixes = platform === "win32" ? WINDOWS_COMMAND_SUFFIXES : [""];
  if (pathApi.isAbsolute(command)) {
    return suffixes.some((suffix) => exists(`${command}${suffix}`));
  }
  const separator = platform === "win32" ? ";" : ":";
  return pathValue
    .split(separator)
    .filter((dir) => dir.length > 0)
    .some((dir) => suffixes.some((suffix) => exists(pathApi.join(dir, `${command}${suffix}`))));
}

export interface ScheduledAgentCommand {
  readonly name: string;
  readonly command: string;
}

export interface ScheduledCommandAuditItem {
  readonly agentName: string;
  readonly command: string;
  readonly reachable: boolean;
}

export interface ScheduledCommandAuditInput extends ScheduledEffectivePathInput {
  readonly agents: readonly ScheduledAgentCommand[];
  readonly exists?: (path: string) => boolean;
}

export function auditScheduledAgentCommands(
  input: ScheduledCommandAuditInput,
): ScheduledCommandAuditItem[] {
  const effectivePath = buildScheduledEffectivePath(input);
  return input.agents.map((agent) => ({
    agentName: agent.name,
    command: agent.command,
    reachable: isCommandReachable(agent.command, effectivePath, input.platform, input.exists),
  }));
}
