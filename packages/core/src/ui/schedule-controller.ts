import { SCHEDULE_STATUSES } from "@roll-agent/runtime";
import type { ScheduleStore } from "@roll-agent/runtime";
import {
  serializeInvocation,
  serializeSchedule,
  type SerializedInvocation,
} from "../cli/commands/schedule-command-utils.ts";
import type { SchedulerServiceProbe } from "../cli/commands/schedule-service-utils.ts";
import { cancelScheduledInvocation } from "../scheduler-host/cancel-invocation.ts";
import type { DaemonLiveness } from "../scheduler-host/daemon-record.ts";
import type { RollUiScheduleController } from "./contracts.ts";

export class RollUiScheduleBusyError extends Error {
  readonly code = "schedule_busy";

  constructor() {
    super("已有一个定时任务操作正在执行，请稍后重试。");
    this.name = "RollUiScheduleBusyError";
  }
}

export class RollUiScheduleRequestError extends Error {
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "RollUiScheduleRequestError";
  }
}

export type ScheduleLedger = Pick<
  ScheduleStore,
  | "listSchedules"
  | "listInvocations"
  | "getInvocation"
  | "getSchedule"
  | "setScheduleStatus"
  | "resumeSchedule"
  | "finalizeCancellation"
  | "findLiveRun"
  | "nextWakeAtMs"
  | "close"
>;

export interface ScheduleLedgerPort {
  open(): Promise<ScheduleLedger>;
}

export interface ScheduleHostStatus {
  readonly dataDir: string;
  readonly logPath: string;
  readonly daemon: {
    readonly liveness: DaemonLiveness;
    readonly pid?: number;
    readonly startedAt?: string;
  };
  readonly service: SchedulerServiceProbe;
  readonly unresolvedPlaceholders: readonly string[];
}

export interface ScheduleHostPort {
  inspect(): Promise<ScheduleHostStatus>;
  installService(): Promise<unknown>;
  restartService(): Promise<unknown>;
  uninstallService(): Promise<unknown>;
}

export interface RollUiScheduleControllerOptions {
  readonly ledger: ScheduleLedgerPort;
  readonly host: ScheduleHostPort;
  readonly authorityDigestFor: (cwd: string) => string;
  readonly cancel?: typeof cancelScheduledInvocation;
}

const MAX_ID_LENGTH = 128;
const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 200;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new RollUiScheduleRequestError(`请求需要合法的 ${label}。`);
  }
  return value;
}

function parseIdRequest(request: unknown, label: string): string {
  if (!isRecord(request)) {
    throw new RollUiScheduleRequestError(`请求需要包含 ${label} 的 JSON 对象。`);
  }
  return parseId(request.id, label);
}

interface ListRunsRequest {
  readonly scheduleId?: string;
  readonly limit: number;
}

function parseRunsRequest(request: unknown): ListRunsRequest {
  if (request === undefined || request === null) {
    return { limit: DEFAULT_RUNS_LIMIT };
  }
  if (!isRecord(request)) {
    throw new RollUiScheduleRequestError("请求参数必须是 JSON 对象。");
  }
  const limit = request.limit ?? DEFAULT_RUNS_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RUNS_LIMIT
  ) {
    throw new RollUiScheduleRequestError(`limit 必须是 1..${String(MAX_RUNS_LIMIT)} 的整数。`);
  }
  if (request.scheduleId === undefined) {
    return { limit };
  }
  return { scheduleId: parseId(request.scheduleId, "scheduleId"), limit };
}

interface CancelRequest {
  readonly id: string;
  readonly kill: boolean;
}

function parseCancelRequest(request: unknown): CancelRequest {
  if (!isRecord(request)) {
    throw new RollUiScheduleRequestError("请求需要包含 invocation id 的 JSON 对象。");
  }
  const id = parseId(request.id, "invocation id");
  const kill = request.kill ?? false;
  if (typeof kill !== "boolean") {
    throw new RollUiScheduleRequestError("kill 必须是布尔值。");
  }
  return { id, kill };
}

export type SerializedScheduleRun = SerializedInvocation & { readonly scheduleName: string };

export function createRollUiScheduleController(
  options: RollUiScheduleControllerOptions,
): RollUiScheduleController {
  const cancel = options.cancel ?? cancelScheduledInvocation;
  let mutating = false;

  const mutate = async <T>(work: () => Promise<T>): Promise<T> => {
    if (mutating) {
      throw new RollUiScheduleBusyError();
    }
    mutating = true;
    try {
      return await work();
    } finally {
      mutating = false;
    }
  };

  const withLedger = async <T>(work: (ledger: ScheduleLedger) => Promise<T> | T): Promise<T> => {
    const ledger = await options.ledger.open();
    try {
      return await work(ledger);
    } finally {
      ledger.close();
    }
  };

  return {
    getStatus: async () => {
      const host = await options.host.inspect();
      return withLedger((ledger) => {
        const schedules = ledger.listSchedules();
        const nextWakeAtMs = ledger.nextWakeAtMs();
        return {
          ...host,
          schedules: {
            total: schedules.length,
            active: schedules.filter((s) => s.status === SCHEDULE_STATUSES.active).length,
            paused: schedules.filter((s) => s.status === SCHEDULE_STATUSES.paused).length,
          },
          nextWakeAt: nextWakeAtMs === undefined ? undefined : new Date(nextWakeAtMs).toISOString(),
        };
      });
    },
    listSchedules: () =>
      withLedger((ledger) =>
        ledger.listSchedules().map((schedule) => {
          const live = ledger.findLiveRun(schedule.id);
          return {
            ...serializeSchedule(schedule),
            liveRun: live === undefined ? undefined : { id: live.id, status: live.status },
          };
        }),
      ),
    listRuns: async (request) => {
      const parsed = parseRunsRequest(request);
      return withLedger((ledger) => {
        const schedules = ledger.listSchedules();
        const names = new Map(schedules.map((s) => [s.id, s.name]));
        const withName = (rows: readonly SerializedInvocation[]): SerializedScheduleRun[] =>
          rows.map((row) => ({
            ...row,
            scheduleName: names.get(row.scheduleId) ?? row.scheduleId,
          }));
        if (parsed.scheduleId !== undefined) {
          if (!names.has(parsed.scheduleId)) {
            throw new Error(`定时任务 ${parsed.scheduleId} 不存在；用列表刷新后重试`);
          }
          return withName(
            ledger.listInvocations(parsed.scheduleId, parsed.limit).map(serializeInvocation),
          );
        }
        const merged = schedules.flatMap((schedule) =>
          ledger.listInvocations(schedule.id, parsed.limit).map(serializeInvocation),
        );
        merged.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
        return withName(merged.slice(0, parsed.limit));
      });
    },
    installService: () => mutate(() => options.host.installService()),
    restartService: () => mutate(() => options.host.restartService()),
    uninstallService: () => mutate(() => options.host.uninstallService()),
    pauseSchedule: async (request) => {
      const id = parseIdRequest(request, "定时任务 id");
      return mutate(() =>
        withLedger((ledger) => {
          if (!ledger.setScheduleStatus(id, SCHEDULE_STATUSES.paused)) {
            throw new Error(`定时任务 ${id} 不存在；刷新列表后重试`);
          }
          return { ok: true as const };
        }),
      );
    },
    resumeSchedule: async (request) => {
      const id = parseIdRequest(request, "定时任务 id");
      return mutate(() =>
        withLedger((ledger) => {
          const schedule = ledger.getSchedule(id);
          if (schedule === undefined) {
            throw new Error(`定时任务 ${id} 不存在；刷新列表后重试`);
          }
          const digest = options.authorityDigestFor(schedule.cwd);
          if (!ledger.resumeSchedule(schedule.id, digest, Date.now())) {
            throw new Error(`定时任务 ${id} 已被删除；刷新列表后重试`);
          }
          return { ok: true as const, authorityChanged: schedule.authorityDigest !== digest };
        }),
      );
    },
    cancelInvocation: async (request) => {
      const parsed = parseCancelRequest(request);
      return mutate(() =>
        withLedger(async (ledger) => {
          const result = await cancel({
            store: ledger,
            invocationId: parsed.id,
            kill: parsed.kill,
          });
          return {
            ok: true as const,
            killed: result.killed,
            unverifiedDescendants: result.unverifiedDescendants,
            previousStatus: result.previousStatus,
            invocation: serializeInvocation(result.invocation),
          };
        }),
      );
    },
  };
}
