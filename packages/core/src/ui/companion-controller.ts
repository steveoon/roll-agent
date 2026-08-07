import { z } from "zod/v4";
import type { CompanionApplication } from "../companion-host/application.ts";
import type {
  RollUiCompanionController,
  RollUiCompanionEnrollRequest,
  RollUiCompanionWorkspaceRequest,
} from "./contracts.ts";

export class RollUiCompanionBusyError extends Error {
  readonly code = "companion_busy" as const;

  constructor() {
    super("Companion 正在执行上一个操作，请等待它结束后再试。");
    this.name = "RollUiCompanionBusyError";
  }
}

export class RollUiCompanionRequestError extends Error {
  readonly code = "invalid_request" as const;

  constructor(message: string) {
    super(message);
    this.name = "RollUiCompanionRequestError";
  }
}

export type CompanionApplicationPort = Pick<
  CompanionApplication,
  | "getStatus"
  | "doctor"
  | "readLogs"
  | "followLogs"
  | "enroll"
  | "unenroll"
  | "enable"
  | "disable"
  | "setWorkspace"
  | "installService"
  | "uninstallService"
  | "start"
  | "stop"
  | "restart"
>;

export interface RollUiCompanionControllerOptions {
  readonly application: CompanionApplicationPort;
}

const enrollRequestSchema = z
  .object({
    pairingCode: z.string().min(1),
    workspace: z.string().min(1),
  })
  .strict();

const workspaceRequestSchema = z
  .object({
    workspace: z.string().min(1),
  })
  .strict();

const ENROLL_REQUEST_MESSAGE = "请填写配对码，并提供 workspace 绝对路径。";
const WORKSPACE_REQUEST_MESSAGE = "请提供 workspace 绝对路径。";

/**
 * Serializes Companion lifecycle mutations so the local UI can never interleave two of them.
 * Validation failures carry hand-written messages: request bodies may hold a pairing code and
 * must never reach an error message, a log line, or the onError channel.
 */
export function createRollUiCompanionController(
  options: RollUiCompanionControllerOptions,
): RollUiCompanionController {
  const application = options.application;
  let mutating = false;

  const mutate = async (work: () => Promise<void>): Promise<{ readonly ok: true }> => {
    if (mutating) {
      throw new RollUiCompanionBusyError();
    }
    mutating = true;
    try {
      await work();
      return { ok: true };
    } finally {
      mutating = false;
    }
  };

  return {
    getStatus: () => application.getStatus(),
    getDoctor: () => application.doctor(),
    readLogs: async () => ({ text: await application.readLogs() }),
    followLogs: (onText, signal) => application.followLogs(onText, signal),
    enroll: (request) => {
      const enrollRequest = parseEnrollRequest(request);
      return mutate(async () => {
        await application.enroll(enrollRequest);
      });
    },
    unenroll: () =>
      mutate(async () => {
        await application.unenroll();
      }),
    enable: () =>
      mutate(async () => {
        await application.enable();
      }),
    disable: () =>
      mutate(async () => {
        await application.disable();
      }),
    setWorkspace: (request) => {
      const workspaceRequest = parseWorkspaceRequest(request);
      return mutate(async () => {
        await application.setWorkspace(workspaceRequest.workspace);
      });
    },
    installService: () => mutate(() => application.installService()),
    uninstallService: () => mutate(() => application.uninstallService()),
    start: () => mutate(() => application.start()),
    stop: () => mutate(() => application.stop()),
    restart: () => mutate(() => application.restart()),
  };
}

function parseEnrollRequest(request: unknown): RollUiCompanionEnrollRequest {
  const parsed = enrollRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new RollUiCompanionRequestError(ENROLL_REQUEST_MESSAGE);
  }
  return parsed.data;
}

function parseWorkspaceRequest(request: unknown): RollUiCompanionWorkspaceRequest {
  const parsed = workspaceRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new RollUiCompanionRequestError(WORKSPACE_REQUEST_MESSAGE);
  }
  return parsed.data;
}
