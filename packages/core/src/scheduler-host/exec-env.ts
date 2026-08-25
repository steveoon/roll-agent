import { isAbsolute } from "node:path";
import { SCHEDULE_DATA_DIR_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";

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
