import type {
  RuntimeModelConfigFailure,
  RuntimeModelConfigIdentity,
  RuntimeModelConfigStatus,
} from "@roll-agent/protocol";
import type { ReasoningPresentation } from "../types/events.ts";

export type RuntimeModelConfigReloadResult =
  | {
      readonly status: "applied";
      readonly model: RuntimeModelConfigIdentity;
      readonly reasoning?: ReasoningPresentation["kind"];
    }
  | { readonly status: "failed"; readonly reason: RuntimeModelConfigFailure };

/** Hosts must check signal after asynchronous preparation and before committing a model. */
export interface RuntimeModelConfigHost {
  readonly initial: RuntimeModelConfigIdentity;
  reload(
    signal?: AbortSignal,
  ): RuntimeModelConfigReloadResult | Promise<RuntimeModelConfigReloadResult>;
}

export interface ModelConfigControllerOptions {
  readonly host: RuntimeModelConfigHost;
  /** Includes admitted/preparing turns, projection jobs and manual maintenance. */
  readonly isBusy: () => boolean;
  readonly initialReasoning?: ReasoningPresentation["kind"];
  readonly onApplied?: (
    result: Extract<RuntimeModelConfigReloadResult, { readonly status: "applied" }>,
  ) => void;
}

/** Shared turn-admission barrier; configuration interpretation and model creation stay in hosts. */
export class ModelConfigController {
  private readonly options: ModelConfigControllerOptions;
  private status: RuntimeModelConfigStatus;
  private applying: AbortController | undefined;
  private closed = false;
  private failedSettlement = false;
  private readonly listeners = new Set<(status: RuntimeModelConfigStatus) => void>();
  private readonly waiters = new Set<(status: RuntimeModelConfigStatus) => void>();

  constructor(options: ModelConfigControllerOptions) {
    this.options = options;
    this.status = {
      status: "applied",
      revision: 0,
      active: { ...options.host.initial, revision: 0, reasoning: options.initialReasoning ?? null },
    };
  }

  getStatus(): RuntimeModelConfigStatus {
    return this.status;
  }

  subscribe(listener: (status: RuntimeModelConfigStatus) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reload(): RuntimeModelConfigStatus {
    this.assertOpen();
    this.setStatus({
      status: "pending",
      active: this.status.active,
      revision: this.status.revision + 1,
    });
    this.tryApply();
    return this.status;
  }

  /** Session-only model changes update the actual identity without claiming a source reload. */
  adoptActive(
    identity: RuntimeModelConfigIdentity,
    reasoning?: ReasoningPresentation["kind"],
  ): void {
    this.assertReady();
    this.setStatus({
      status: "applied",
      revision: this.status.revision,
      active: { ...identity, revision: this.status.active.revision, reasoning: reasoning ?? null },
    });
  }

  assertReady(): void {
    this.assertOpen();
    if (this.status.status === "pending") throw new Error("模型配置待应用，请等待当前轮次结束");
    if (this.status.status === "failed") throw new Error("模型配置应用失败，请重试应用");
  }

  tryApply(): void {
    if (this.closed || this.status.status !== "pending") return;
    if (this.failedSettlement) {
      this.setStatus({ ...this.status, status: "failed", reason: "apply-failed" });
      return;
    }
    if (this.applying !== undefined || this.options.isBusy()) return;
    const revision = this.status.revision;
    const applying = new AbortController();
    this.applying = applying;
    try {
      const result = this.options.host.reload(applying.signal);
      if (result instanceof Promise) {
        result.then(
          (resolved) => {
            this.finish(applying, revision, resolved);
          },
          () => {
            this.finish(applying, revision, { status: "failed", reason: "apply-failed" });
          },
        );
      } else {
        this.finish(applying, revision, result);
      }
    } catch {
      this.finish(applying, revision, { status: "failed", reason: "apply-failed" });
    }
  }

  whenSettled(): Promise<RuntimeModelConfigStatus> {
    if (this.status.status !== "pending") return Promise.resolve(this.status);
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  /** A failed turn projection cannot establish safe settlement, even after another reload. */
  fail(): void {
    if (this.closed) return;
    this.failedSettlement = true;
    this.applying?.abort();
    this.applying = undefined;
    this.setStatus({ ...this.status, status: "failed", reason: "apply-failed" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.applying?.abort();
    this.applying = undefined;
    if (this.status.status === "pending") {
      this.setStatus({ ...this.status, status: "failed", reason: "apply-failed" });
    }
    this.listeners.clear();
  }

  private finish(
    applying: AbortController,
    revision: number,
    result: RuntimeModelConfigReloadResult,
  ): void {
    if (this.closed || this.applying !== applying || applying.signal.aborted) return;
    let active = this.status.active;
    if (result.status === "applied") {
      active = { ...result.model, revision, reasoning: result.reasoning ?? null };
      try {
        this.options.onApplied?.(result);
      } catch {
        result = { status: "failed", reason: "apply-failed" };
      }
    }
    if (this.closed || this.applying !== applying || applying.signal.aborted) return;
    this.applying = undefined;
    const newerRequest = this.status.revision > revision;
    if (newerRequest) {
      this.setStatus({ status: "pending", revision: this.status.revision, active });
      this.tryApply();
    } else if (result.status === "applied") {
      this.setStatus({ status: "applied", revision, active });
    } else {
      this.setStatus({ status: "failed", revision, active, reason: result.reason });
    }
  }

  private setStatus(status: RuntimeModelConfigStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        /* Presentation listeners cannot reopen admission. */
      }
    }
    if (this.status.status !== "pending") {
      for (const resolve of this.waiters) resolve(this.status);
      this.waiters.clear();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("模型配置控制器已关闭");
  }
}
