import { StructuredToolError } from "@roll-agent/sdk";

/**
 * per-browserInstance 互斥队列。
 *
 * chat 模式下 LLM 可能并行发起多个操作同一浏览器实例的 tool call（AI SDK 以
 * Promise.all 并发执行），而同一实例的页面操作共享页面状态，必须串行。
 * 该模块以 module 级 Map 保存每个实例 id 的队尾 promise —— 进程级共享，
 * 因此可同时覆盖 Streamable HTTP 多 session 并发（如 chat 与 orchestrator
 * 同时连接同一 agent 进程）的场景。不同实例 id 互不影响，保持并行。
 */

export interface WithBrowserInstanceLockOptions {
  /**
   * 当前 MCP 请求的取消信号。排队等待期间或出队时若已取消，
   * 直接丢弃该次执行（抛 cancelled_while_queued），避免客户端已超时
   * 放弃的请求仍然落地执行（"幽灵操作"）。
   */
  readonly signal?: AbortSignal;
  /** 发生争用（前面有同实例操作在执行）并成功拿到锁后回调，参数为排队等待毫秒数 */
  readonly onWait?: (waitedMs: number) => void;
}

const lockTails = new Map<string, Promise<void>>();

/** 同一 instanceId 的 run 串行执行；不同 instanceId 并行不受影响。 */
export async function withBrowserInstanceLock<T>(
  instanceId: string,
  run: () => Promise<T>,
  options: WithBrowserInstanceLockOptions = {},
): Promise<T> {
  const { signal, onWait } = options;
  throwIfCancelled(instanceId, signal, 0);

  const prior = lockTails.get(instanceId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockTails.set(instanceId, current);

  const queuedAt = performance.now();
  if (prior !== undefined) {
    try {
      await waitForTurn(prior, signal);
    } catch (error) {
      // 放弃执行也必须放行队列，否则后续排队者会永久卡死。
      // 但不能立即 release：后续排队者等待的是 current，若此刻前序操作仍在
      // 执行，立即 release 会让它们提前放行。必须等前序完成后再释放队位。
      // prior 由 release() resolve，永不 reject，无需错误处理。
      prior.then(() => {
        release();
        cleanupTail(instanceId, current);
      });
      if (error instanceof QueueAbortError) {
        throwCancelledWhileQueued(instanceId, elapsedSince(queuedAt));
      }
      throw error;
    }
  }

  // 从这里起已持有锁：任何抛错（包括 onWait 回调异常）都必须走 finally 放行队列
  try {
    if (prior !== undefined) {
      onWait?.(elapsedSince(queuedAt));
    }
    // 出队执行前再查一次：等待期间客户端可能已超时取消
    throwIfCancelled(instanceId, signal, elapsedSince(queuedAt));
    return await run();
  } finally {
    release();
    cleanupTail(instanceId, current);
  }
}

/** 队列内部使用的 abort 标记错误，出口处统一转换为 StructuredToolError */
class QueueAbortError extends Error {
  constructor() {
    super("Aborted while queued");
    this.name = "QueueAbortError";
  }
}

async function waitForTurn(prior: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await prior;
    return;
  }
  if (signal.aborted) {
    throw new QueueAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new QueueAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // prior 由 release() resolve，永不 reject
    prior.then(() => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new QueueAbortError());
        return;
      }
      resolve();
    });
  });
}

function throwIfCancelled(
  instanceId: string,
  signal: AbortSignal | undefined,
  queuedMs: number,
): void {
  if (signal?.aborted === true) {
    throwCancelledWhileQueued(instanceId, queuedMs);
  }
}

function throwCancelledWhileQueued(instanceId: string, queuedMs: number): never {
  throw new StructuredToolError({
    code: "cancelled_while_queued",
    message:
      `Request was cancelled while waiting for another in-flight operation ` +
      `on browser instance "${instanceId}". The tool did not execute.`,
    details: {
      browserInstance: instanceId,
      queuedMs: Math.round(queuedMs),
    },
  });
}

function cleanupTail(instanceId: string, current: Promise<void>): void {
  if (lockTails.get(instanceId) === current) {
    lockTails.delete(instanceId);
  }
}

function elapsedSince(startedAt: number): number {
  return performance.now() - startedAt;
}
