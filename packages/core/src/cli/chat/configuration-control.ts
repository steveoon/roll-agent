import type { RuntimeModelConfigIdentity, RuntimeModelConfigStatus } from "@roll-agent/protocol";
import type { RuntimeModelConfigReloadResult } from "@roll-agent/runtime";
import type { RollConfig } from "../../config/schema.ts";
import type { ThinkingLevel } from "../../llm/thinking-levels.ts";
import type { RuntimeModule } from "../../runtime-host/engine-factory.ts";
import { modelConfigRequiresRestart } from "../../runtime-host/runtime-model-config.ts";

export interface ChatConfigurationSnapshot {
  readonly text: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
}

export interface ChatOperationLifecycle {
  begin(): void;
  end(): void;
}

export interface ChatConfigurationControl {
  snapshot(): ChatConfigurationSnapshot;
  reload(): ChatConfigurationSnapshot;
  subscribe(listener: (snapshot: ChatConfigurationSnapshot) => void): () => void;
}

const FAILURE_NOTICES = {
  "invalid-config": "配置读取或模型解析失败，请检查所选配置后重试 /reload",
  "restart-required": "配置包含需要重启的变化，请重启 roll chat",
  "apply-failed": "模型应用失败，请重试 /reload",
} as const;

export function createChatConfigurationControl(input: {
  readonly runtime: Pick<RuntimeModule, "ModelConfigController">;
  readonly initial: RuntimeModelConfigIdentity;
  readonly initialReasoning?: "summary" | "text";
  readonly startupConfig: RollConfig;
  readonly source: string;
  readonly workspace: string;
  readonly read?: () => RollConfig;
  readonly getThinkingLevel: () => ThinkingLevel;
  readonly apply: (
    config: RollConfig,
    signal: AbortSignal | undefined,
  ) => Promise<Extract<RuntimeModelConfigReloadResult, { readonly status: "applied" }>>;
}) {
  let operations = 0;
  let closed = false;
  const unavailable = () =>
    new Error(
      "当前会话未绑定配置文件，无法重新加载；当前模型仍可使用。请使用 --config 重启后应用配置文件。",
    );
  const controller = new input.runtime.ModelConfigController({
    host: {
      initial: input.initial,
      async reload(signal) {
        try {
          if (input.read === undefined) throw unavailable();
          const latest = input.read();
          if (modelConfigRequiresRestart(input.startupConfig, latest)) {
            return { status: "failed", reason: "restart-required" };
          }
          return await input.apply(latest, signal);
        } catch {
          return { status: "failed", reason: "invalid-config" };
        }
      },
    },
    isBusy: () => operations > 0,
    ...(input.initialReasoning === undefined ? {} : { initialReasoning: input.initialReasoning }),
  });
  const describe = (status: RuntimeModelConfigStatus): ChatConfigurationSnapshot => {
    const active = status.active;
    return {
      model: active?.model ?? "未应用",
      thinkingLevel: input.getThinkingLevel(),
      text: [
        `项目：${input.workspace}`,
        `配置：${input.source}`,
        `有效模型：${active ? `${active.provider}/${active.model}` : "尚未应用"}`,
        status.status === "applied"
          ? `模型配置已应用（修订 ${String(status.active.revision)}）`
          : status.status === "pending"
            ? "模型配置等待当前操作结束后应用"
            : FAILURE_NOTICES[status.reason],
      ].join("\n"),
    };
  };
  return {
    snapshot: () => describe(controller.getStatus()),
    reload() {
      // Missing capability is not a failed application of a bound source.
      if (input.read === undefined) throw unavailable();
      return describe(controller.reload());
    },
    subscribe: (listener: (snapshot: ChatConfigurationSnapshot) => void) =>
      controller.subscribe((status) => listener(describe(status))),
    assertReady: () => controller.assertReady(),
    guard() {
      controller.assertReady();
      const captured = controller.getStatus();
      return () => {
        controller.assertReady();
        if (controller.getStatus() !== captured) {
          throw new Error("模型配置已变化，请重新执行此操作");
        }
      };
    },
    adoptActive: (identity: RuntimeModelConfigIdentity, reasoning?: "summary" | "text") =>
      controller.adoptActive(identity, reasoning),
    lifecycle: {
      begin() {
        if (closed) throw new Error("当前会话正在关闭");
        controller.assertReady();
        operations++;
      },
      end() {
        operations--;
        controller.tryApply();
      },
    } satisfies ChatOperationLifecycle,
    close() {
      closed = true;
      controller.close();
    },
  };
}
