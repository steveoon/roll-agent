import { isAbsolute, posix, win32 } from "node:path";
import { SCHEDULE_DATA_DIR_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";

function resolvePathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

/**
 * 调度执行环境（launchd/schtasks 最小环境）看不到交互 shell 的 PATH。
 * 把当前 node 所在目录前置进 PATH，让 exec 子进程派生的 stdio Agent
 * （裸 `node` 命令）与 Shell 工具命令能找到同一个 node。幂等。
 */
export function prependExecDirToPath(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
): void {
  const pathApi = platform === "win32" ? win32 : posix;
  const separator = platform === "win32" ? ";" : ":";
  const directory = pathApi.dirname(execPath);
  const key = resolvePathKey(env, platform);
  const current = env[key];
  if (current === undefined || current.length === 0) {
    env[key] = directory;
    return;
  }
  if (current.split(separator).includes(directory)) {
    return;
  }
  env[key] = `${directory}${separator}${current}`;
}

/**
 * 合入 roll.config.yaml 的 scheduler.env 用户声明段（代理、额外 PATH 等）。
 * 用户值覆盖同名已有值。
 */
export function applySchedulerConfigEnv(
  env: NodeJS.ProcessEnv,
  schedulerEnv: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(schedulerEnv)) {
    env[key] = value;
  }
}

export interface ScheduleExecEnv {
  readonly ownershipToken: string;
  readonly dataDir: string;
}

export function takeScheduleExecEnv(env: NodeJS.ProcessEnv): ScheduleExecEnv {
  const ownershipToken = env[SCHEDULE_TOKEN_ENV];
  const dataDir = env[SCHEDULE_DATA_DIR_ENV];
  delete env[SCHEDULE_TOKEN_ENV];
  delete env[SCHEDULE_DATA_DIR_ENV];
  if (ownershipToken === undefined || ownershipToken.length === 0) {
    throw new Error(`缺少 ${SCHEDULE_TOKEN_ENV}；该命令只应由 roll schedule daemon 调用`);
  }
  if (dataDir === undefined || !isAbsolute(dataDir)) {
    throw new Error(
      `缺少或非法的 ${SCHEDULE_DATA_DIR_ENV}；该命令只应由 roll schedule daemon 调用`,
    );
  }
  return { ownershipToken, dataDir };
}
