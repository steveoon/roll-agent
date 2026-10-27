import type { ScheduleRecord } from "../scheduler/types.ts";
import type { ScheduleTimingInput } from "../scheduler/trigger.ts";

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

export const SCHEDULE_READINESS_WARNING_CODES = [
  "service-not-installed",
  "daemon-not-running",
  "data-dir-mismatch",
  "daemon-version-mismatch",
  "unresolved-placeholders",
] as const;

export interface ScheduleReadinessWarning {
  readonly code: (typeof SCHEDULE_READINESS_WARNING_CODES)[number];
  readonly message: string;
}

export interface ScheduleExecutionReadiness {
  readonly daemonRunning: boolean;
  readonly serviceInstalled: boolean;
  readonly automaticRunsReady: boolean;
  readonly warnings: readonly ScheduleReadinessWarning[];
}

export interface ScheduleToolCreateRequest extends ScheduleTimingInput {
  readonly name: string;
  readonly prompt: string;
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
  readonly everyMs: number | undefined;
  readonly trigger: ScheduleRecord["trigger"];
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
  readonly trigger: {
    readonly everyMs?: number | undefined;
    readonly display: string;
    readonly spec?: ScheduleRecord["trigger"];
  };
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
  readonly timeZone?: string | undefined;
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
