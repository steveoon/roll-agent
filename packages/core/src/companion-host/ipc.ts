import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  COMPANION_CONTROL_MAX_FRAME_BYTES,
  COMPANION_CONTROL_PROTOCOL_VERSION,
} from "./constants.ts";
import {
  companionControlRequestSchema,
  companionControlResponseSchema,
  type CompanionControlRequest,
  type CompanionControlResponse,
  type CompanionHostStatus,
} from "./schema.ts";
import type { CompanionLogger } from "./logger.ts";

const DEFAULT_CONTROL_IDLE_TIMEOUT_MS = 5_000;

const SILENT_CONTROL_LOGGER: CompanionLogger = {
  info: () => undefined,
  error: () => undefined,
};

export interface CompanionControlHandlers {
  readonly getStatus: () => CompanionHostStatus | Promise<CompanionHostStatus>;
  readonly stop: () => void | Promise<void>;
}

export class CompanionControlServer {
  private readonly endpoint: string;
  private readonly handlers: CompanionControlHandlers;
  private readonly platform: NodeJS.Platform;
  private readonly idleTimeoutMs: number;
  private readonly logger: CompanionLogger;
  private server: Server | undefined;

  constructor(options: {
    readonly endpoint: string;
    readonly handlers: CompanionControlHandlers;
    readonly platform?: NodeJS.Platform;
    readonly idleTimeoutMs?: number;
    readonly logger?: CompanionLogger;
  }) {
    this.endpoint = options.endpoint;
    this.handlers = options.handlers;
    this.platform = options.platform ?? process.platform;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_CONTROL_IDLE_TIMEOUT_MS;
    this.logger = options.logger ?? SILENT_CONTROL_LOGGER;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }
    if (this.platform !== "win32") {
      await mkdir(dirname(this.endpoint), { recursive: true, mode: 0o700 });
      await prepareUnixSocket(this.endpoint);
    }
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const rejectStartup = (reason: Error) => reject(reason);
      server.once("error", rejectStartup);
      server.listen(createControlListenOptions(this.endpoint), () => {
        server.off("error", rejectStartup);
        server.on("error", (reason: Error) => {
          this.logger.error(`Companion control server error: ${reason.message}`);
        });
        resolve();
      });
    });
    this.server = server;
    try {
      if (this.platform !== "win32") {
        await chmod(this.endpoint, 0o600);
      }
    } catch (error: unknown) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.platform !== "win32") {
      await unlink(this.endpoint).catch((error: unknown) => {
        if (!isFileSystemError(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }

  private handleSocket(socket: Socket): void {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("timeout", () => socket.destroy());
    socket.setTimeout(this.idleTimeoutMs);
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > COMPANION_CONTROL_MAX_FRAME_BYTES) {
        handled = true;
        this.writeResponse(socket, invalidRequestResponse());
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      socket.setTimeout(0);
      this.handleLine(buffer.slice(0, newline))
        .then((response) => this.writeResponse(socket, response))
        .catch(() => this.writeResponse(socket, internalErrorResponse()));
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(line: string): Promise<CompanionControlResponse> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return invalidRequestResponse();
    }
    const parsed = companionControlRequestSchema.safeParse(value);
    if (!parsed.success) {
      return invalidRequestResponse();
    }
    if (parsed.data.type === "stop") {
      await this.handlers.stop();
    }
    return {
      version: COMPANION_CONTROL_PROTOCOL_VERSION,
      ok: true,
      status: await this.handlers.getStatus(),
    };
  }

  private writeResponse(socket: Socket, response: CompanionControlResponse): void {
    socket.end(`${JSON.stringify(response)}\n`);
    socket.setTimeout(this.idleTimeoutMs);
  }
}

export function createControlListenOptions(endpoint: string): {
  readonly path: string;
  readonly readableAll: false;
  readonly writableAll: false;
} {
  return {
    path: endpoint,
    // Node's Windows named-pipe ACL remains scoped to the creating user unless these flags are
    // explicitly enabled. Unix permissions are tightened to 0600 immediately after listen.
    readableAll: false,
    writableAll: false,
  };
}

export async function sendCompanionControlRequest(
  endpoint: string,
  request: CompanionControlRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<CompanionControlResponse> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise<CompanionControlResponse>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for Roll Companion control service"));
    }, timeoutMs);
    const finish = (error: Error | null, response?: CompanionControlResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) {
        reject(error);
      } else if (response !== undefined) {
        resolve(response);
      } else {
        reject(new Error("Roll Companion control service returned no response"));
      }
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(companionControlRequestSchema.parse(request))}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > COMPANION_CONTROL_MAX_FRAME_BYTES) {
        finish(new Error("Roll Companion control response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("Roll Companion control response is invalid JSON"));
        return;
      }
      const parsed = companionControlResponseSchema.safeParse(value);
      if (!parsed.success) {
        finish(new Error("Roll Companion control response is invalid"));
        return;
      }
      finish(null, parsed.data);
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Roll Companion control service closed early")));
  });
}

async function prepareUnixSocket(endpoint: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(endpoint);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!metadata.isSocket()) {
    throw new Error("Companion control endpoint exists and is not a Unix socket");
  }
  try {
    await sendCompanionControlRequest(
      endpoint,
      { version: COMPANION_CONTROL_PROTOCOL_VERSION, type: "status" },
      { timeoutMs: 250 },
    );
    throw new Error("Another Roll Companion service is already running");
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message === "Another Roll Companion service is already running"
    ) {
      throw error;
    }
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ECONNREFUSED")) {
      await unlink(endpoint);
      return;
    }
    throw new Error("Companion control endpoint is active but did not prove compatible");
  }
}

function invalidRequestResponse(): CompanionControlResponse {
  return {
    version: COMPANION_CONTROL_PROTOCOL_VERSION,
    ok: false,
    code: "INVALID_REQUEST",
  };
}

function internalErrorResponse(): CompanionControlResponse {
  return {
    version: COMPANION_CONTROL_PROTOCOL_VERSION,
    ok: false,
    code: "INTERNAL_ERROR",
  };
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
