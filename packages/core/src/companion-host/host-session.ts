import {
  inspectEnvironmentDiagnostics,
  describeEnvironmentDiagnostics,
} from "../config/environment-diagnostics.ts";
import { FileCompanionConfigStore } from "./config-store.ts";
import { createCompanionPaths } from "./paths.ts";
import {
  RollNodeClient,
  RollRuntimeExitedError,
  RollProtocolViolationError,
  RollRequestTimeoutError,
  RollRpcError,
  type RuntimeClientExit,
} from "@roll-agent/client-node";
import {
  CompanionInteractionBroker,
  CompanionRelayBridgeV11,
  CompanionWorkspace,
  OutboundCompanionRelayV11,
  createRuntimeServerRequestHandlers,
  createWebSocketRelayTransportV11,
  type RelayTransportV11,
  type WebSocketLikeV11,
} from "@roll-agent/companion";
import { RUNTIME_PROTOCOL_VERSION } from "@roll-agent/protocol";
import type { CompanionConfig } from "./schema.ts";
import type { BundledRollInvocation } from "./invocation.ts";
import { resolveRelayEndpoint } from "./constants.ts";
import {
  createOfficialRelayResponderContext,
  createOfficialRelayResponderPolicy,
  createP0RemoteRequestPolicy,
  createRemoteAppOutputPolicy,
} from "./policy.ts";

const RELAY_OPEN_TIMEOUT_MS = 15_000;

export type OpenableCompanionWebSocket = WebSocketLikeV11 & {
  readonly addEventListener: {
    (type: "open", listener: () => void): void;
    (type: "error", listener: () => void): void;
  };
  readonly removeEventListener: {
    (type: "open", listener: () => void): void;
    (type: "error", listener: () => void): void;
  };
};

export type CompanionWebSocketFactory = (url: string) => OpenableCompanionWebSocket;

export interface ManagedCompanionSession {
  readonly runtimeExit: Promise<RuntimeClientExit>;
  stop(): Promise<void>;
}

export interface CompanionSessionFactory {
  create(config: CompanionConfig, credential: string): Promise<ManagedCompanionSession>;
}

export class DefaultCompanionSessionFactory implements CompanionSessionFactory {
  private readonly invocation: BundledRollInvocation;
  private readonly configStore: FileCompanionConfigStore;
  private readonly createWebSocket: CompanionWebSocketFactory;

  constructor(options: {
    readonly invocation: BundledRollInvocation;
    readonly configPath?: string;
    readonly createWebSocket?: CompanionWebSocketFactory;
  }) {
    this.invocation = options.invocation;
    this.configStore = new FileCompanionConfigStore(
      options.configPath ?? createCompanionPaths().configPath,
    );
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  }

  async create(config: CompanionConfig, credential: string): Promise<ManagedCompanionSession> {
    const diagnostics = inspectEnvironmentDiagnostics({
      cwd: config.cwd,
      environment: "service",
      env: process.env,
    });
    if (diagnostics.blocking) {
      throw new Error(`后台运行环境配置需要处理：${describeEnvironmentDiagnostics(diagnostics)}`);
    }
    const interactionBroker = new CompanionInteractionBroker();
    let hasStderr = false;
    const client = await RollNodeClient.start({
      cwd: config.cwd,
      command: this.invocation.command,
      args: this.invocation.runtimeArgs,
      clientName: "roll-companion",
      // Raw stderr may contain configuration or credentials. Only note its presence; structured
      // configuration diagnostics above are the source of user-facing environment guidance.
      onStderr: () => {
        hasStderr = true;
      },
      serverRequestHandlers: createRuntimeServerRequestHandlers(interactionBroker),
    }).catch((error: unknown) => {
      const exit = describeRuntimeStartupFailure(error);
      throw new Error(
        `Runtime 无法启动或初始化${exit}。请检查 Node/Roll 版本及路径，并在绑定的 Workspace 运行 roll doctor。${hasStderr ? "子进程产生了额外诊断输出；为保护配置内容，未将原始 stderr 转发到页面。" : ""}`,
      );
    });
    try {
      assertBundledRuntimeProtocolVersion(client.getInitializationResult().protocolVersion);
      const workspace = new CompanionWorkspace({
        client,
        workspaceId: config.workspaceId,
        interactionBroker,
        remoteAppOutputPolicy: createRemoteAppOutputPolicy(this.configStore, config.workspaceId),
        // Runtime policy is the sole approval fact source. A Runtime `deny` never creates an
        // Interaction; `confirm` is completed by the authenticated remote responder.
        localApprovalPolicy: () => "allow",
      });
      const workspaces = new Map([[config.workspaceId, workspace]]);
      const bridge = new CompanionRelayBridgeV11({
        deviceId: config.deviceId,
        pairingToken: credential,
        protocolVersion: "1.2",
        workspaces,
      });
      const requestPolicy = createP0RemoteRequestPolicy(config.workspaceId);
      const responderPolicy = createOfficialRelayResponderPolicy(config.workspaceId);
      const responderContext = createOfficialRelayResponderContext();
      const outbound = new OutboundCompanionRelayV11({
        bridge,
        connectTransport: async () => ({
          transport: await openRelayTransport(
            resolveRelayEndpoint().companionUrl,
            this.createWebSocket,
          ),
          requestPolicy,
          responderPolicy,
          responderContext,
        }),
      });
      const runtimeExit = new Promise<RuntimeClientExit>((resolve) => {
        client.onExit(resolve);
      });
      let stopped = false;
      outbound.start();
      return {
        runtimeExit,
        async stop() {
          if (stopped) {
            return;
          }
          stopped = true;
          await stopRelayBeforeRuntime(outbound, client);
        },
      };
    } catch (error: unknown) {
      await client.shutdown().catch(() => undefined);
      throw error;
    }
  }
}

export function assertBundledRuntimeProtocolVersion(negotiated: string): void {
  if (negotiated !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Bundled Companion Runtime must negotiate Runtime Protocol ${RUNTIME_PROTOCOL_VERSION}; negotiated ${negotiated}`,
    );
  }
}

export async function stopRelayBeforeRuntime(
  relay: { readonly stop: () => void },
  runtime: { readonly shutdown: () => Promise<unknown> },
): Promise<void> {
  // The public Relay path is detached before the trusted local stdio Runtime is closed.
  relay.stop();
  await runtime.shutdown();
}

async function openRelayTransport(
  url: string,
  createWebSocket: CompanionWebSocketFactory,
): Promise<RelayTransportV11> {
  const socket = createWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Timed out connecting to the official Relay")),
      RELAY_OPEN_TIMEOUT_MS,
    );
    const opened = () => finish();
    const failed = () => finish(new Error("Unable to connect to the official Relay"));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      if (error === undefined) {
        resolve();
      } else {
        socket.close();
        reject(error);
      }
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
  });
  return createWebSocketRelayTransportV11(socket);
}

function defaultWebSocketFactory(url: string): OpenableCompanionWebSocket {
  if (globalThis.WebSocket === undefined) {
    throw new Error("This bundled Node runtime does not provide WebSocket support");
  }
  return new globalThis.WebSocket(url);
}

/** Only emit known classes/codes. Error names, messages, paths and arbitrary codes may hold secrets. */
export function describeRuntimeStartupFailure(error: unknown): string {
  if (error instanceof RollRuntimeExitedError) {
    return `（退出码 ${String(error.code)}，信号 ${String(error.signal)}）`;
  }
  if (error instanceof RollProtocolViolationError) {
    return "（RollProtocolViolationError：Runtime 协议校验失败）";
  }
  if (error instanceof RollRequestTimeoutError) {
    return "（RollRequestTimeoutError：Runtime 初始化请求超时）";
  }
  if (error instanceof RollRpcError) {
    return Number.isSafeInteger(error.code)
      ? `（RollRpcError：错误码 ${String(error.code)}）`
      : "（RollRpcError）";
  }
  if (error instanceof Error && "code" in error) {
    const known = Object.entries({
      ENOENT: "（ENOENT：启动命令或工作目录不存在）",
      EACCES: "（EACCES：启动权限不足）",
      EPERM: "（EPERM：系统拒绝启动）",
      ENOEXEC: "（ENOEXEC：可执行文件格式无效）",
    }).find(([code]) => code === error.code);
    if (known !== undefined) return known[1];
  }
  return "";
}
