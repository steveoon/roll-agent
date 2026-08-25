import { createHash } from "node:crypto";
import type { RollConfig } from "../config/schema.ts";

export const AUTHORITY_DIGEST_VERSION = 1 as const;

export interface AuthoritySnapshot {
  readonly version: typeof AUTHORITY_DIGEST_VERSION;
  readonly approval: {
    readonly default: RollConfig["runtime"]["approval"]["default"];
    readonly overrides: ReadonlyArray<readonly [string, string]>;
  };
  readonly shell: {
    readonly enabled: boolean;
    readonly autoApproveSafe: boolean;
    readonly sessionEnabled: boolean;
  };
}

export function createAuthoritySnapshot(config: RollConfig): AuthoritySnapshot {
  return {
    version: AUTHORITY_DIGEST_VERSION,
    approval: {
      default: config.runtime.approval.default,
      overrides: Object.entries(config.runtime.approval.overrides).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    },
    shell: {
      enabled: config.runtime.shell.enabled,
      autoApproveSafe: config.runtime.shell.autoApproveSafe,
      sessionEnabled: config.runtime.shell.session.enabled,
    },
  };
}

export function computeAuthorityDigest(config: RollConfig): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(createAuthoritySnapshot(config)))
    .digest("hex");
  return `v${String(AUTHORITY_DIGEST_VERSION)}:${digest}`;
}

export function describeAuthorityDrift(
  scheduleId: string,
  recorded: string | undefined,
  current: string,
): string {
  const recordedLabel = recorded === undefined ? "未记录" : recorded.slice(0, 15);
  return `权限边界已变化（登记时 ${recordedLabel}，当前 ${current.slice(0, 15)}）：runtime.approval / runtime.shell 配置与登记时不同，已停止执行；确认后运行 roll schedule resume ${scheduleId} 重新授权`;
}
