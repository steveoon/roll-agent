import {
  CANCEL_INVOCATION_OUTCOMES,
  EXECUTOR_LIVENESS,
  INVOCATION_STATUSES,
} from "@roll-agent/runtime";
import type { ExecutorIdentity, InvocationRecord, ScheduleStore } from "@roll-agent/runtime";
import { KILL_RESULTS, descendantsUnverified, type KillResult } from "./cancel-descendants.ts";
import { isTreeSettled } from "./execute-invocation.ts";
import {
  KILL_PROCESS_TREE_OUTCOMES,
  probeExecutorLiveness,
  terminateExecutorWithGrace,
} from "./executor-liveness.ts";
import { terminateInvocationTree, trackedGroupsFromPersisted } from "./invocation-tree.ts";

export const CANCEL_KILL_CONFIRM_TIMEOUT_MS = 5_000;
const KILL_CONFIRM_POLL_MS = 100;

export type CancelInvocationStore = Pick<ScheduleStore, "getInvocation" | "finalizeCancellation">;

export interface CancelScheduledInvocationInput {
  readonly store: CancelInvocationStore;
  readonly invocationId: string;
  readonly kill: boolean;
}

export interface CancelScheduledInvocationDeps {
  readonly terminateExecutor?: typeof terminateExecutorWithGrace;
  readonly probeLiveness?: typeof probeExecutorLiveness;
  readonly teardownTree?: typeof terminateInvocationTree;
  readonly platform?: NodeJS.Platform;
  readonly killConfirmTimeoutMs?: number;
  readonly killConfirmPollMs?: number;
  readonly now?: () => number;
}

export interface CancelScheduledInvocationResult {
  readonly invocation: InvocationRecord;
  readonly previousStatus: InvocationRecord["status"];
  readonly previousExecutorPid: number | undefined;
  readonly killed: boolean;
  readonly unverifiedDescendants: boolean;
}

interface ResolvedCancelDeps {
  readonly terminateExecutor: typeof terminateExecutorWithGrace;
  readonly probeLiveness: typeof probeExecutorLiveness;
  readonly teardownTree: typeof terminateInvocationTree;
  readonly platform: NodeJS.Platform;
  readonly killConfirmTimeoutMs: number;
  readonly killConfirmPollMs: number;
  readonly now: () => number;
}

function resolveDeps(deps: CancelScheduledInvocationDeps): ResolvedCancelDeps {
  return {
    terminateExecutor: deps.terminateExecutor ?? terminateExecutorWithGrace,
    probeLiveness: deps.probeLiveness ?? probeExecutorLiveness,
    teardownTree: deps.teardownTree ?? terminateInvocationTree,
    platform: deps.platform ?? process.platform,
    killConfirmTimeoutMs: deps.killConfirmTimeoutMs ?? CANCEL_KILL_CONFIRM_TIMEOUT_MS,
    killConfirmPollMs: deps.killConfirmPollMs ?? KILL_CONFIRM_POLL_MS,
    now: deps.now ?? Date.now,
  };
}

async function killAndConfirmExit(
  executor: ExecutorIdentity,
  deps: ResolvedCancelDeps,
): Promise<KillResult> {
  const outcome = await deps.terminateExecutor(executor);
  if (outcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
    const liveness = deps.probeLiveness(executor);
    if (liveness === EXECUTOR_LIVENESS.dead) {
      return deps.platform === "win32" ? KILL_RESULTS.unverifiable : KILL_RESULTS.confirmed;
    }
    return liveness === EXECUTOR_LIVENESS.unknown
      ? KILL_RESULTS.unverifiable
      : KILL_RESULTS.treeKillFailed;
  }
  const deadline = deps.now() + deps.killConfirmTimeoutMs;
  while (deps.now() < deadline) {
    if (deps.probeLiveness(executor) === EXECUTOR_LIVENESS.dead) {
      return KILL_RESULTS.confirmed;
    }
    await new Promise((resolve) => setTimeout(resolve, deps.killConfirmPollMs));
  }
  return deps.probeLiveness(executor) === EXECUTOR_LIVENESS.dead
    ? KILL_RESULTS.confirmed
    : KILL_RESULTS.stillAlive;
}

export async function cancelScheduledInvocation(
  input: CancelScheduledInvocationInput,
  depsInput: CancelScheduledInvocationDeps = {},
): Promise<CancelScheduledInvocationResult> {
  const deps = resolveDeps(depsInput);
  const { store, invocationId } = input;
  const before = store.getInvocation(invocationId);
  if (before === undefined) {
    throw new Error(`invocation ${invocationId} 不存在`);
  }
  let killed = false;
  let killResult: KillResult | undefined;
  if (
    input.kill &&
    before.status === INVOCATION_STATUSES.running &&
    before.executor !== undefined
  ) {
    const result = await killAndConfirmExit(before.executor, deps);
    killResult = result;
    if (result === KILL_RESULTS.treeKillFailed) {
      throw new Error(
        `无法整体终止 invocation ${invocationId} 的 exec 进程树（pid ${String(before.executor.pid)}；Windows 上 taskkill 失败或进程不是进程组首领），未取消、未释放单例`,
      );
    }
    killed = result === KILL_RESULTS.confirmed;
  }
  const current = store.getInvocation(invocationId);
  if (current === undefined) {
    throw new Error(`invocation ${invocationId} 不存在`);
  }
  if (current.attempt !== before.attempt) {
    throw new Error(
      `invocation ${invocationId} 已被其他 worker 接管（attempt ${String(before.attempt)} → ${String(current.attempt)}），未取消、未改写新 owner 的账本`,
    );
  }
  let tree:
    | {
        readonly trackedGroups: typeof current.treeTrackedGroups;
        readonly unsettled: boolean;
        readonly survivorPids: readonly number[];
      }
    | undefined;
  let teardownError: string | undefined;
  const treeBearing =
    before.status === INVOCATION_STATUSES.claimed ||
    before.status === INVOCATION_STATUSES.running ||
    before.status === INVOCATION_STATUSES.retry;
  if (
    input.kill &&
    treeBearing &&
    (before.status !== INVOCATION_STATUSES.running || before.executor === undefined || killed)
  ) {
    const report = await deps.teardownTree({
      invocationId,
      selfPid: 0,
      trackedGroups: trackedGroupsFromPersisted(current.treeTrackedGroups),
      ...(current.executor !== undefined
        ? { previousExecutorPid: current.executor.pid }
        : before.executor !== undefined
          ? { previousExecutorPid: before.executor.pid }
          : {}),
    });
    tree = {
      trackedGroups: isTreeSettled(report) ? [] : current.treeTrackedGroups,
      unsettled: !isTreeSettled(report),
      survivorPids: report.survivorPids,
    };
    teardownError = report.error;
  }
  const outcome = store.finalizeCancellation({
    id: invocationId,
    reason: "已由用户取消",
    nowMs: deps.now(),
    expectedAttempt: before.attempt,
    ...(tree !== undefined ? { tree } : {}),
  });
  if (outcome === CANCEL_INVOCATION_OUTCOMES.ownershipChanged) {
    throw new Error(
      `invocation ${invocationId} 已被其他 worker 接管，未取消、未改写新 owner 的账本`,
    );
  }
  if (outcome === CANCEL_INVOCATION_OUTCOMES.terminal) {
    throw new Error(`invocation ${invocationId} 已是终态（${before.status}），无需取消`);
  }
  if (outcome === CANCEL_INVOCATION_OUTCOMES.notFound) {
    throw new Error(`invocation ${invocationId} 不存在`);
  }
  if (outcome === CANCEL_INVOCATION_OUTCOMES.executorAlive) {
    throw new Error(
      input.kill
        ? `exec 进程树 (pid ${String(before.executor?.pid ?? "?")}) 在 ${String(deps.killConfirmTimeoutMs)} ms 内未全部退出，未取消；请稍后重试`
        : `invocation ${invocationId} 的 exec 进程或其进程树仍有存活成员（pid ${String(before.executor?.pid ?? "?")}），取消需要加 --kill`,
    );
  }
  if (outcome === CANCEL_INVOCATION_OUTCOMES.executorUnknown) {
    throw new Error(
      `无法确认 invocation ${invocationId} 的 exec 进程已退出，未取消；确认进程已不存在后可用 --abandon（危险：会释放单例）`,
    );
  }
  if (outcome === CANCEL_INVOCATION_OUTCOMES.treeUnsettled) {
    const survivors = (tree?.survivorPids ?? current.treeSurvivorPids).map(String).join(", ");
    throw new Error(
      input.kill
        ? survivors.length > 0
          ? `invocation ${invocationId} 的进程树在终止后仍有存活成员（pid ${survivors}），未取消、未释放单例`
          : `无法枚举 invocation ${invocationId} 的进程树${teardownError === undefined ? "" : `：${teardownError}`}，未取消、未释放单例`
        : `invocation ${invocationId} 仍有未清干净的进程树，取消需要加 --kill`,
    );
  }
  const after = store.getInvocation(invocationId);
  if (after === undefined) {
    throw new Error(`invocation ${invocationId} 不存在`);
  }
  return {
    invocation: after,
    previousStatus: before.status,
    previousExecutorPid: before.executor?.pid,
    killed,
    unverifiedDescendants: descendantsUnverified({
      killResult,
      killed,
      platform: deps.platform,
    }),
  };
}
