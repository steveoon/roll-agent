import type { SchedulerServiceBinary } from "./service-state.ts";

export const SCHEDULER_SERVICE_RESTART_COMMAND = "roll schedule service restart";

export const SCHEDULER_SERVICE_BINARY_STATUSES = {
  unknown: "unknown",
  current: "current",
  outdated: "outdated",
  broken: "broken",
} as const;
export type SchedulerServiceBinaryStatus =
  (typeof SCHEDULER_SERVICE_BINARY_STATUSES)[keyof typeof SCHEDULER_SERVICE_BINARY_STATUSES];

export interface SchedulerServiceBinaryReport {
  readonly status: SchedulerServiceBinaryStatus;
  readonly recorded: SchedulerServiceBinary | undefined;
  readonly current: SchedulerServiceBinary;
  readonly commandExists: boolean | undefined;
  readonly entrypointExists: boolean | undefined;
  readonly versionMismatch: boolean | undefined;
  readonly reason: string | undefined;
}

export function describeSchedulerServiceBinary(
  recorded: SchedulerServiceBinary | undefined,
  current: SchedulerServiceBinary,
  exists: (path: string) => boolean,
): SchedulerServiceBinaryReport {
  if (recorded === undefined) {
    return {
      status: SCHEDULER_SERVICE_BINARY_STATUSES.unknown,
      recorded,
      current,
      commandExists: undefined,
      entrypointExists: undefined,
      versionMismatch: undefined,
      reason: `service metadata 未记录安装时的 node / roll 入口（旧版本安装）；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 重装后即可检测二进制是否过期`,
    };
  }
  const commandExists = exists(recorded.command);
  const entrypointExists = exists(recorded.cliEntrypoint);
  const versionMismatch = recorded.rollVersion !== current.rollVersion;
  const base = {
    recorded,
    current,
    commandExists,
    entrypointExists,
    versionMismatch,
  };
  if (!commandExists) {
    return {
      ...base,
      status: SCHEDULER_SERVICE_BINARY_STATUSES.broken,
      reason: `服务定义指向的 node 已不存在：${recorded.command}（daemon 无法被服务管理器启动）；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 用当前 node ${current.command} 重装`,
    };
  }
  if (!entrypointExists) {
    return {
      ...base,
      status: SCHEDULER_SERVICE_BINARY_STATUSES.broken,
      reason: `服务定义指向的 roll 入口已不存在：${recorded.cliEntrypoint}（daemon 无法被服务管理器启动）；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 用当前入口 ${current.cliEntrypoint} 重装`,
    };
  }
  if (versionMismatch) {
    return {
      ...base,
      status: SCHEDULER_SERVICE_BINARY_STATUSES.outdated,
      reason: `服务定义固化的是 roll v${recorded.rollVersion}，当前为 v${current.rollVersion}；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 切换服务定义和 daemon`,
    };
  }
  if (recorded.command !== current.command) {
    return {
      ...base,
      status: SCHEDULER_SERVICE_BINARY_STATUSES.outdated,
      reason: `服务定义指向的 node 与当前不同：${recorded.command} → ${current.command}；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 切换`,
    };
  }
  if (recorded.cliEntrypoint !== current.cliEntrypoint) {
    return {
      ...base,
      status: SCHEDULER_SERVICE_BINARY_STATUSES.outdated,
      reason: `服务定义指向的 roll 入口与当前不同：${recorded.cliEntrypoint} → ${current.cliEntrypoint}；执行 ${SCHEDULER_SERVICE_RESTART_COMMAND} 切换`,
    };
  }
  return { ...base, status: SCHEDULER_SERVICE_BINARY_STATUSES.current, reason: undefined };
}
