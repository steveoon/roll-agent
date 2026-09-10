import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  SCHEDULER_LIMITS,
  ScheduleStore,
  ScheduleStoreError,
  ScheduleTriggerError,
  createIntervalTrigger,
  describeTrigger,
  formatDuration,
  parseMaxRunText,
  readScheduleLedger,
  type ScheduleRecord,
} from "@roll-agent/runtime";
import { loadConfig } from "../config/loader.ts";
import { auditScheduledServicePlaceholders } from "../config/placeholder-audit.ts";
import { computeAuthorityDigest } from "./authority.ts";
import { DAEMON_LIVENESS, inspectDaemon } from "./daemon-record.ts";
import { probeExecutorLiveness } from "./executor-liveness.ts";
import { probeInvocationTreeSettled, trackedGroupsFromPersisted } from "./invocation-tree.ts";
import { describeScheduleRounds } from "./schedule-rounds.ts";
import { createSchedulerPaths } from "./paths.ts";
import {
  SCHEDULER_SERVICE_STATE_PHASES,
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
} from "./service-state.ts";

export const SCHEDULE_TOOL_ERROR_CODES = {
  invalidInput: "invalid_input",
  configError: "config_error",
  admissionStale: "admission_stale",
  migrationRequired: "migration_required",
} as const;

export interface ScheduleToolError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export interface ScheduleReadinessWarning {
  readonly code:
    | "service-not-installed"
    | "daemon-not-running"
    | "data-dir-mismatch"
    | "unresolved-placeholders";
  readonly message: string;
}

export interface ScheduleExecutionReadiness {
  readonly daemonRunning: boolean;
  readonly serviceInstalled: boolean;
  readonly automaticRunsReady: boolean;
  readonly warnings: readonly ScheduleReadinessWarning[];
}

export interface ScheduleToolCreateRequest {
  readonly name: string;
  readonly prompt: string;
  readonly every: string;
  readonly cwd?: string | undefined;
  readonly maxRun?: string | undefined;
  readonly rounds?: number | undefined;
}

export interface ScheduleCreateAdmission {
  readonly ok: true;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionCwd: string;
  readonly everyMs: number;
  readonly everyDisplay: string;
  readonly maxRunMs: number | undefined;
  readonly maxRounds: ScheduleRecord["maxRounds"];
  readonly maxRunDisplay: string;
  readonly dataDir: string;
  readonly authorityDigest: string;
  readonly firstRunAt: string;
  readonly readiness: ScheduleExecutionReadiness;
}

export interface ScheduleToolScheduleView {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: ScheduleRecord["status"];
  readonly rounds: { readonly max: number | null; readonly started: number };
  readonly roundsDisplay: string;
  readonly trigger: { readonly everyMs: number; readonly display: string };
  readonly maxRun: {
    readonly explicit: boolean;
    readonly effectiveMs: number;
    readonly display: string;
  };
  readonly nextRunAt: string | undefined;
  readonly createdAt: string;
}

export interface ScheduleToolCreateOutcome {
  readonly ok: true;
  readonly created: boolean;
  readonly reauthorized: boolean;
  readonly schedule: ScheduleToolScheduleView;
  readonly readiness: ScheduleExecutionReadiness;
}

export interface ScheduleToolListQuery {
  readonly status?: "all" | ScheduleRecord["status"] | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ScheduleToolListItem {
  readonly id: string;
  readonly name: string;
  readonly status: ScheduleRecord["status"];
  readonly rounds: { readonly max: number | null; readonly started: number };
  readonly roundsDisplay: string;
  readonly trigger: string;
  readonly cwd: string;
  readonly promptExcerpt: string;
  readonly maxRun: string;
  readonly nextRunAt: string | undefined;
  readonly lastRunAt: string | undefined;
  readonly lastError: string | undefined;
}

export interface ScheduleToolListOutcome {
  readonly ok: true;
  readonly total: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly schedules: readonly ScheduleToolListItem[];
  readonly readiness: ScheduleExecutionReadiness;
}

export interface ScheduleToolExtendRequest {
  readonly scheduleId: string;
  readonly rounds: number;
  readonly expectedMaxRounds: number;
  readonly requestId: string;
}

export interface ScheduleExtendAdmission {
  readonly ok: true;
  readonly request: ScheduleToolExtendRequest;
  readonly sessionCwd: string;
  readonly dataDir: string;
  readonly authorityDigest: string;
  readonly schedule: ScheduleRecord;
}

export interface ScheduleToolExtendOutcome {
  readonly ok: true;
  readonly extended: boolean;
  readonly requestId: string;
  readonly schedule: ScheduleToolScheduleView;
  readonly readiness: ScheduleExecutionReadiness;
}

export interface ScheduleToolPort {
  captureExtend?(
    request: ScheduleToolExtendRequest,
    sessionCwd: string,
  ): ScheduleExtendAdmission | ScheduleToolError;
  extend?(
    admission: ScheduleExtendAdmission,
  ): Promise<ScheduleToolExtendOutcome | ScheduleToolError>;
  captureCreate(
    request: ScheduleToolCreateRequest,
    sessionCwd: string,
  ): ScheduleCreateAdmission | ScheduleToolError;
  create(
    admission: ScheduleCreateAdmission,
  ): Promise<ScheduleToolCreateOutcome | ScheduleToolError>;
  list(
    query: ScheduleToolListQuery,
    sessionCwd: string,
  ): Promise<ScheduleToolListOutcome | ScheduleToolError>;
}

export const SCHEDULE_LIST_DEFAULT_LIMIT = 50;
export const SCHEDULE_LIST_MAX_LIMIT = 100;
export const SCHEDULE_PROMPT_EXCERPT_CHARS = 200;

function toolError(code: string, message: string): ScheduleToolError {
  return { ok: false, code, message };
}

function fromKnownError(error: unknown): ScheduleToolError {
  if (error instanceof ScheduleStoreError || error instanceof ScheduleTriggerError) {
    return toolError(error.code, error.message);
  }
  return toolError(
    SCHEDULE_TOOL_ERROR_CODES.configError,
    error instanceof Error ? error.message : String(error),
  );
}

function canonicalizeCwd(
  requested: string | undefined,
  sessionCwd: string,
): string | ScheduleToolError {
  const base = isAbsolute(sessionCwd) ? sessionCwd : resolve(sessionCwd);
  const target =
    requested === undefined || requested.length === 0 ? base : resolve(base, requested);
  try {
    const real = realpathSync(target);
    if (!statSync(real).isDirectory()) {
      return toolError(SCHEDULE_TOOL_ERROR_CODES.invalidInput, `cwd 不是目录：${target}`);
    }
    return real;
  } catch {
    return toolError(SCHEDULE_TOOL_ERROR_CODES.invalidInput, `cwd 不存在或不可访问：${target}`);
  }
}

function probeUnresolvedPlaceholders(
  configCwd: string,
  secretsPath: string | undefined,
): ScheduleReadinessWarning | undefined {
  const audit = auditScheduledServicePlaceholders({
    loadOptions: { cwd: configCwd },
    ...(secretsPath === undefined ? {} : { secretsPath }),
  });
  if (audit === undefined || audit.unresolved.length === 0) {
    return undefined;
  }
  const names = audit.unresolved.map((item) => `\${${item.name}}`).join("、");
  return {
    code: "unresolved-placeholders",
    message: `配置占位符 ${names} 在调度服务环境下无法解析（调度服务不会加载交互 shell 的环境变量），任务运行时会因此失败；把值写入 ~/.roll-agent/secrets.env（chmod 600）或运行 roll doctor 查看详情`,
  };
}

function probeReadiness(
  dataDir: string,
  serviceStatePath: string,
  configCwd: string,
  secretsPath: string | undefined,
): ScheduleExecutionReadiness {
  const paths = createSchedulerPaths(dataDir);
  const daemonRunning = inspectDaemon(paths.daemonRecordPath).liveness === DAEMON_LIVENESS.running;
  const inspection = inspectSchedulerServiceState(serviceStatePath);
  const serviceInstalled =
    inspection.status === "valid" &&
    inspection.state.phase === SCHEDULER_SERVICE_STATE_PHASES.installed;
  const installedDataDir = inspection.status === "valid" ? inspection.state.dataDir : undefined;
  const dataDirMatches = installedDataDir === undefined || installedDataDir === paths.dataDir;
  const warnings: ScheduleReadinessWarning[] = [];
  if (!serviceInstalled) {
    warnings.push({
      code: "service-not-installed",
      message: daemonRunning
        ? "daemon 正在前台运行，任务当前可以触发；但调度服务未安装，注销或重启电脑后不会自动恢复"
        : "尚未安装调度服务且 daemon 未运行：任务已登记但不会自动执行；请在 roll ui 的定时任务面板或用 roll schedule service install 安装",
    });
  } else if (!daemonRunning) {
    warnings.push({
      code: "daemon-not-running",
      message: "已安装调度服务但 daemon 未运行；用 roll schedule service status 查看原因",
    });
  }
  if (serviceInstalled && !dataDirMatches) {
    warnings.push({
      code: "data-dir-mismatch",
      message: `已安装的调度服务固定在数据目录 ${installedDataDir ?? ""}，与当前配置 ${paths.dataDir} 不一致；该任务不会被现有服务执行`,
    });
  }
  const placeholderWarning = probeUnresolvedPlaceholders(configCwd, secretsPath);
  if (placeholderWarning !== undefined) {
    warnings.push(placeholderWarning);
  }
  return {
    daemonRunning,
    serviceInstalled,
    automaticRunsReady: serviceInstalled && daemonRunning && dataDirMatches,
    warnings,
  };
}

function toScheduleView(record: ScheduleRecord): ScheduleToolScheduleView {
  return {
    id: record.id,
    name: record.name,
    prompt: record.prompt,
    cwd: record.cwd,
    status: record.status,
    rounds: { max: record.maxRounds ?? null, started: record.roundsStarted },
    roundsDisplay: describeScheduleRounds(record),
    trigger: { everyMs: record.trigger.everyMs, display: describeTrigger(record.trigger) },
    maxRun: {
      explicit: record.maxRunMs !== undefined,
      effectiveMs: record.maxRunMs ?? SCHEDULER_LIMITS.maxRunMs,
      display: formatDuration(record.maxRunMs ?? SCHEDULER_LIMITS.maxRunMs),
    },
    nextRunAt:
      record.nextRunAtMs === undefined ? undefined : new Date(record.nextRunAtMs).toISOString(),
    createdAt: new Date(record.createdAtMs).toISOString(),
  };
}

function toListItem(record: ScheduleRecord): ScheduleToolListItem {
  const excerpt =
    record.prompt.length > SCHEDULE_PROMPT_EXCERPT_CHARS
      ? `${record.prompt.slice(0, SCHEDULE_PROMPT_EXCERPT_CHARS)}…`
      : record.prompt;
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    rounds: { max: record.maxRounds ?? null, started: record.roundsStarted },
    roundsDisplay: describeScheduleRounds(record),
    trigger: describeTrigger(record.trigger),
    cwd: record.cwd,
    promptExcerpt: excerpt,
    maxRun: formatDuration(record.maxRunMs ?? SCHEDULER_LIMITS.maxRunMs),
    nextRunAt:
      record.nextRunAtMs === undefined ? undefined : new Date(record.nextRunAtMs).toISOString(),
    lastRunAt:
      record.lastRunAtMs === undefined ? undefined : new Date(record.lastRunAtMs).toISOString(),
    lastError: record.lastError,
  };
}

interface ScheduleLedgerContext {
  readonly dataDir: string;
  readonly maxSchedules: number;
}

function resolveLedgerContext(sessionCwd: string): ScheduleLedgerContext {
  const { config } = loadConfig({ cwd: sessionCwd });
  return {
    dataDir: createSchedulerPaths(config.scheduler.dataDir).dataDir,
    maxSchedules: config.scheduler.maxSchedules,
  };
}

function resolveAuthorityDigest(taskCwd: string): string {
  return computeAuthorityDigest(loadConfig({ cwd: taskCwd }).config);
}

export interface ScheduleToolBindingOptions {
  readonly serviceStatePath?: string;
  readonly secretsPath?: string;
}

export function createScheduleToolBinding(
  options: ScheduleToolBindingOptions = {},
): ScheduleToolPort {
  const serviceStatePath = options.serviceStatePath ?? schedulerServiceStatePath();
  return {
    captureExtend: (request, sessionCwd) => {
      if (
        !Number.isSafeInteger(request.rounds) ||
        request.rounds < 1 ||
        !Number.isSafeInteger(request.expectedMaxRounds) ||
        request.expectedMaxRounds < 1 ||
        !Number.isSafeInteger(request.rounds + request.expectedMaxRounds) ||
        request.requestId.length < 1 ||
        request.requestId.length > 128
      ) {
        return toolError(
          SCHEDULE_TOOL_ERROR_CODES.invalidInput,
          "追加轮数和原额度必须为正安全整数且总额度不能溢出；requestId 长度为 1..128",
        );
      }
      try {
        const ledger = resolveLedgerContext(sessionCwd);
        const snapshot = readScheduleLedger(ledger.dataDir);
        if (snapshot.status === "migration-required") {
          return toolError(
            SCHEDULE_TOOL_ERROR_CODES.migrationRequired,
            "定时任务账本需要迁移，请先在终端运行 roll schedule list",
          );
        }
        const schedule = snapshot.schedules.find((record) => record.id === request.scheduleId);
        if (schedule === undefined) {
          return toolError(SCHEDULE_TOOL_ERROR_CODES.invalidInput, "定时任务不存在");
        }
        if (schedule.maxRounds === undefined) {
          return toolError(SCHEDULE_TOOL_ERROR_CODES.invalidInput, "不限轮数的任务不能追加轮数");
        }
        const cwd = canonicalizeCwd(schedule.cwd, sessionCwd);
        if (typeof cwd !== "string" || cwd !== schedule.cwd) {
          return toolError(SCHEDULE_TOOL_ERROR_CODES.admissionStale, "任务工作目录已变化或不可用");
        }
        return {
          ok: true,
          request: { ...request },
          sessionCwd,
          dataDir: ledger.dataDir,
          authorityDigest: resolveAuthorityDigest(schedule.cwd),
          schedule,
        };
      } catch (error) {
        return fromKnownError(error);
      }
    },
    extend: async (admission) => {
      try {
        const ledger = resolveLedgerContext(admission.sessionCwd);
        const cwd = canonicalizeCwd(admission.schedule.cwd, admission.sessionCwd);
        if (
          ledger.dataDir !== admission.dataDir ||
          typeof cwd !== "string" ||
          cwd !== admission.schedule.cwd ||
          resolveAuthorityDigest(cwd) !== admission.authorityDigest
        ) {
          return toolError(
            SCHEDULE_TOOL_ERROR_CODES.admissionStale,
            "调度账本、工作目录或权限边界在确认期间发生变化，请重新发起确认",
          );
        }
        const store = new ScheduleStore(ledger.dataDir, {
          maxSchedules: ledger.maxSchedules,
          executorLiveness: probeExecutorLiveness,
          treeLiveness: (record) =>
            probeInvocationTreeSettled({
              invocationId: record.id,
              selfPid: 0,
              trackedGroups: trackedGroupsFromPersisted(record.treeTrackedGroups),
              ...(record.executor === undefined
                ? {}
                : { previousExecutorPid: record.executor.pid }),
            }),
        });
        try {
          const current = store.getSchedule(admission.request.scheduleId);
          const captured = admission.schedule;
          if (
            current === undefined ||
            current.id !== captured.id ||
            current.name !== captured.name ||
            current.prompt !== captured.prompt ||
            current.cwd !== captured.cwd ||
            current.trigger.kind !== captured.trigger.kind ||
            current.trigger.everyMs !== captured.trigger.everyMs ||
            current.maxRunMs !== captured.maxRunMs ||
            current.createdAtMs !== captured.createdAtMs
          ) {
            return toolError(
              SCHEDULE_TOOL_ERROR_CODES.admissionStale,
              "任务定义在确认期间发生变化，请重新发起确认",
            );
          }
          const result = store.extendSchedule({
            scheduleId: admission.request.scheduleId,
            additionalRounds: admission.request.rounds,
            expectedMaxRounds: admission.request.expectedMaxRounds,
            requestId: admission.request.requestId,
            authorityDigest: admission.authorityDigest,
          });
          return {
            ok: true,
            extended: result.extended,
            requestId: admission.request.requestId,
            schedule: toScheduleView(result.schedule),
            readiness: probeReadiness(ledger.dataDir, serviceStatePath, cwd, options.secretsPath),
          };
        } finally {
          store.close();
        }
      } catch (error) {
        return fromKnownError(error);
      }
    },
    captureCreate: (request, sessionCwd) => {
      const cwd = canonicalizeCwd(request.cwd, sessionCwd);
      if (typeof cwd !== "string") {
        return cwd;
      }
      try {
        if (
          request.rounds !== undefined &&
          (!Number.isSafeInteger(request.rounds) || request.rounds < 1)
        ) {
          return toolError(SCHEDULE_TOOL_ERROR_CODES.invalidInput, "rounds 必须是正安全整数");
        }
        const trigger = createIntervalTrigger(request.every);
        const maxRunMs =
          request.maxRun === undefined || request.maxRun.length === 0
            ? undefined
            : parseMaxRunText(request.maxRun);
        const ledger = resolveLedgerContext(sessionCwd);
        return {
          ok: true,
          name: request.name,
          prompt: request.prompt,
          cwd,
          sessionCwd,
          everyMs: trigger.everyMs,
          everyDisplay: describeTrigger(trigger),
          maxRunMs,
          maxRounds: request.rounds,
          maxRunDisplay: formatDuration(maxRunMs ?? SCHEDULER_LIMITS.maxRunMs),
          dataDir: ledger.dataDir,
          authorityDigest: resolveAuthorityDigest(cwd),
          firstRunAt: new Date(Date.now() + trigger.everyMs).toISOString(),
          readiness: probeReadiness(ledger.dataDir, serviceStatePath, cwd, options.secretsPath),
        };
      } catch (error) {
        return fromKnownError(error);
      }
    },
    create: async (admission) => {
      let ledger: ScheduleLedgerContext;
      try {
        const cwd = canonicalizeCwd(admission.cwd, admission.cwd);
        if (typeof cwd !== "string" || cwd !== admission.cwd) {
          return toolError(
            SCHEDULE_TOOL_ERROR_CODES.admissionStale,
            "任务工作目录在确认期间发生变化，已放弃创建；请重新发起",
          );
        }
        ledger = resolveLedgerContext(admission.sessionCwd);
        if (
          ledger.dataDir !== admission.dataDir ||
          resolveAuthorityDigest(admission.cwd) !== admission.authorityDigest
        ) {
          return toolError(
            SCHEDULE_TOOL_ERROR_CODES.admissionStale,
            "调度配置或权限边界在确认期间发生变化，已放弃创建；请重新发起以按当前配置确认",
          );
        }
      } catch (error) {
        return fromKnownError(error);
      }
      const store = new ScheduleStore(ledger.dataDir, {
        maxSchedules: ledger.maxSchedules,
        executorLiveness: probeExecutorLiveness,
        treeLiveness: (record) =>
          probeInvocationTreeSettled({
            invocationId: record.id,
            selfPid: 0,
            trackedGroups: [],
            ...(record.executor !== undefined ? { previousExecutorPid: record.executor.pid } : {}),
          }),
      });
      try {
        const result = store.createScheduleIdempotent({
          name: admission.name,
          prompt: admission.prompt,
          cwd: admission.cwd,
          trigger: { kind: "interval", everyMs: admission.everyMs },
          authorityDigest: admission.authorityDigest,
          ...(admission.maxRounds === undefined ? {} : { maxRounds: admission.maxRounds }),
          ...(admission.maxRunMs !== undefined ? { maxRunMs: admission.maxRunMs } : {}),
        });
        return {
          ok: true,
          created: result.created,
          reauthorized: result.reauthorized,
          schedule: toScheduleView(result.schedule),
          readiness: probeReadiness(
            ledger.dataDir,
            serviceStatePath,
            admission.cwd,
            options.secretsPath,
          ),
        };
      } catch (error) {
        return fromKnownError(error);
      } finally {
        store.close();
      }
    },
    list: async (query, sessionCwd) => {
      let dataDir: string;
      try {
        const { config } = loadConfig({ cwd: sessionCwd });
        dataDir = createSchedulerPaths(config.scheduler.dataDir).dataDir;
      } catch (error) {
        return fromKnownError(error);
      }
      const ledger = readScheduleLedger(dataDir);
      if (ledger.status === "migration-required") {
        return toolError(
          SCHEDULE_TOOL_ERROR_CODES.migrationRequired,
          `定时任务账本 schema 版本 ${String(ledger.schemaVersion)} 与当前 roll 不一致；请先在终端运行任一 roll schedule 命令完成迁移`,
        );
      }
      const status = query.status ?? "all";
      const filtered =
        status === "all"
          ? ledger.schedules
          : ledger.schedules.filter((schedule) => schedule.status === status);
      const offset = Math.max(0, Math.trunc(query.offset ?? 0));
      const limit = Math.min(
        SCHEDULE_LIST_MAX_LIMIT,
        Math.max(1, Math.trunc(query.limit ?? SCHEDULE_LIST_DEFAULT_LIMIT)),
      );
      const page = filtered.slice(offset, offset + limit);
      return {
        ok: true,
        total: filtered.length,
        offset,
        hasMore: offset + page.length < filtered.length,
        schedules: page.map(toListItem),
        readiness: probeReadiness(dataDir, serviceStatePath, sessionCwd, options.secretsPath),
      };
    },
  };
}
