import {
  RUNTIME_ERROR_CODES,
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_METHODS,
  isRuntimeMethod,
  runtimeMethodSchemas,
  type JsonRpcRequest,
  type RuntimeMethod,
} from "@roll-agent/protocol";
import { RuntimeService, RuntimeServiceError } from "../service/runtime-service.ts";
import type { JsonRpcConnection } from "./protocol.ts";

export class RuntimeProtocolAdapter {
  private readonly service: RuntimeService;
  private readonly connection: JsonRpcConnection;
  private readonly unsubscribe: () => void;
  private initialized = false;

  constructor(service: RuntimeService, connection: JsonRpcConnection) {
    this.service = service;
    this.connection = connection;
    this.unsubscribe = service.onEvent((event) => {
      if (!this.initialized) {
        return;
      }
      this.connection.send({
        jsonrpc: "2.0",
        method: RUNTIME_EVENT_NOTIFICATION,
        params: event,
      });
    });
  }

  handles(method: string): method is RuntimeMethod {
    return isRuntimeMethod(method);
  }

  async dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (!this.handles(request.method)) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.capabilityUnavailable,
        `未知 Runtime Protocol 方法：${request.method}`,
      );
    }
    if (request.method === RUNTIME_METHODS.initialize) {
      const params = runtimeMethodSchemas[RUNTIME_METHODS.initialize].params.parse(request.params);
      const result = this.service.initialize(params);
      this.initialized = true;
      return result;
    }
    if (!this.initialized) {
      throw new RuntimeServiceError(
        RUNTIME_ERROR_CODES.initializeRequired,
        "调用 Runtime Protocol 方法前必须先完成 initialize",
      );
    }

    switch (request.method) {
      case RUNTIME_METHODS.threadList:
        return this.service.listThreads(
          runtimeMethodSchemas[RUNTIME_METHODS.threadList].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadCreate:
        return this.service.createThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadCreate].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadOpen:
        return this.service.openThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadOpen].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadSnapshot:
        return this.service.snapshotThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadSnapshot].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadRename:
        return this.service.renameThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadRename].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadDelete:
        return this.service.deleteThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadDelete].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadDetach:
        return this.service.detachThread(
          runtimeMethodSchemas[RUNTIME_METHODS.threadDetach].params.parse(request.params),
        );
      case RUNTIME_METHODS.threadCapabilities:
        return this.service.threadCapabilities(
          runtimeMethodSchemas[RUNTIME_METHODS.threadCapabilities].params.parse(request.params),
        );
      case RUNTIME_METHODS.turnStart:
        return this.service.startTurn(
          runtimeMethodSchemas[RUNTIME_METHODS.turnStart].params.parse(request.params),
        );
      case RUNTIME_METHODS.turnCancel:
        return this.service.cancelTurn(
          runtimeMethodSchemas[RUNTIME_METHODS.turnCancel].params.parse(request.params),
        );
      case RUNTIME_METHODS.approvalRespond:
        return this.service.respondApproval(
          runtimeMethodSchemas[RUNTIME_METHODS.approvalRespond].params.parse(request.params),
        );
      case RUNTIME_METHODS.operationGet:
        return this.service.getOperation(
          runtimeMethodSchemas[RUNTIME_METHODS.operationGet].params.parse(request.params),
        );
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.service.close();
  }
}
