import { createHash } from "node:crypto";
import type { AgentLogger } from "@roll-agent/sdk";
import {
  isConfiguredMultiBrowserInstancePool,
  resolveRecruitmentTrackingAgentId,
} from "../runtime-holder.ts";

export const RECRUITMENT_EVENT_TYPES = [
  "message_received",
  "message_sent",
  "candidate_contacted",
  "wechat_exchanged",
] as const;

type RecruitmentEventType = (typeof RECRUITMENT_EVENT_TYPES)[number];

type RecruitmentCandidate = {
  readonly name: string;
  readonly position: string;
  readonly age?: string;
  readonly gender?: string;
  readonly education?: string;
  readonly expectedSalary?: string;
  readonly expectedLocation?: string;
};

type RecruitmentJob = {
  readonly jobId?: number;
  readonly jobName?: string;
};

type RecruitmentEventDetails = Readonly<Record<string, string | number | boolean | undefined>>;

export type RecruitmentEventPayload = {
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly sourcePlatform: "zhipin";
  readonly dataSource: "api_callback";
  readonly eventType: RecruitmentEventType;
  readonly eventTime: string;
  readonly candidate: RecruitmentCandidate;
  readonly job?: RecruitmentJob;
  readonly details: RecruitmentEventDetails;
};

export type RecruitmentEventDraft = Omit<RecruitmentEventPayload, "agentId" | "eventTime"> & {
  readonly eventTime?: string;
};

type RecruitmentEventsConfig = {
  readonly enabled: boolean;
  readonly apiBaseUrl: string;
  readonly apiToken?: string;
  readonly defaultAgentId?: string;
};

type RecruitmentEventPostDeps = {
  readonly fetch: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
};

type RecruitmentEventRecorder = (
  event: RecruitmentEventDraft,
  logger: AgentLogger,
) => Promise<void> | void;

const DEFAULT_POST_DEPS = {
  fetch,
  env: process.env,
} satisfies RecruitmentEventPostDeps;
const DEFAULT_RECRUITMENT_EVENTS_API_BASE_URL = "https://huajune.duliday.com";

let postDepsOverride: Partial<RecruitmentEventPostDeps> | undefined;
let recorderOverride: RecruitmentEventRecorder | undefined;
const missingConfigWarnings = new Set<string>();

function readEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function readEnvBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = readEnvString(env, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean env value "true" or "false" for ${name}, received "${value}".`);
}

function loadRecruitmentEventsConfig(env: NodeJS.ProcessEnv): RecruitmentEventsConfig {
  const enabledFlag = readEnvBoolean(env, "RECRUITMENT_EVENTS_ENABLED");
  const apiBaseUrl =
    readEnvString(env, "RECRUITMENT_EVENTS_API_BASE_URL") ??
    DEFAULT_RECRUITMENT_EVENTS_API_BASE_URL;
  const apiToken = readEnvString(env, "RECRUITMENT_EVENTS_API_TOKEN");
  const defaultAgentId = readEnvString(env, "RECRUITMENT_EVENTS_DEFAULT_AGENT_ID");

  return {
    enabled: enabledFlag ?? true,
    apiBaseUrl,
    ...(apiToken !== undefined ? { apiToken } : {}),
    ...(defaultAgentId !== undefined ? { defaultAgentId } : {}),
  };
}

function resolveRecruitmentAgentId(
  config: RecruitmentEventsConfig,
  logger: AgentLogger,
): string | undefined {
  const agentId = resolveRecruitmentTrackingAgentId(config.defaultAgentId);
  if (agentId !== undefined) {
    return agentId;
  }

  if (isConfiguredMultiBrowserInstancePool()) {
    warnOnce(
      logger,
      "missing-instance-tracking",
      "Recruitment event skipped: select a browserInstance, configure tracking-agent-id on the active browser instance, or set RECRUITMENT_EVENTS_DEFAULT_AGENT_ID.",
    );
  }

  return undefined;
}

function warnOnce(logger: AgentLogger, key: string, message: string): void {
  if (missingConfigWarnings.has(key)) return;
  missingConfigWarnings.add(key);
  logger.warn(message);
}

function buildEndpointUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/recruitment-events`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function getRecruitmentEventsApiError(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.results)) {
    return undefined;
  }

  const failedResult = body.data.results.find(
    (result) => isRecord(result) && readStringProperty(result, "status") === "error",
  );
  if (!isRecord(failedResult)) return undefined;

  const idempotencyKey = readStringProperty(failedResult, "idempotencyKey");
  const error = failedResult.error;
  const code = isRecord(error) ? readStringProperty(error, "code") : undefined;
  const message = isRecord(error) ? readStringProperty(error, "message") : undefined;
  const eventPart = idempotencyKey !== undefined ? ` ${idempotencyKey}` : "";
  const codePart = code !== undefined ? ` ${code}` : "";
  const messagePart = message !== undefined ? `: ${message}` : "";
  return `Recruitment events API rejected event${eventPart}${codePart}${messagePart}`;
}

async function postRecruitmentEvent(
  event: RecruitmentEventDraft,
  logger: AgentLogger,
  deps: RecruitmentEventPostDeps,
): Promise<void> {
  const config = loadRecruitmentEventsConfig(deps.env);
  if (!config.enabled) {
    return;
  }

  const agentId = resolveRecruitmentAgentId(config, logger);
  if (config.apiToken === undefined) {
    warnOnce(
      logger,
      "missing-required-config",
      "Recruitment events tracking is enabled by default; require RECRUITMENT_EVENTS_API_TOKEN.",
    );
    return;
  }

  if (agentId === undefined) {
    if (!isConfiguredMultiBrowserInstancePool()) {
      warnOnce(
        logger,
        "missing-required-config",
        "Recruitment events tracking is enabled by default; require RECRUITMENT_EVENTS_DEFAULT_AGENT_ID.",
      );
    }
    return;
  }

  const payload = {
    events: [
      {
        ...event,
        agentId,
        eventTime: event.eventTime ?? new Date().toISOString(),
      },
    ],
  };

  const response = await deps.fetch(buildEndpointUrl(config.apiBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Recruitment events API request failed (${response.status})${text.length > 0 ? `: ${text}` : ""}`,
    );
  }

  const responseBody: unknown = await response.json().catch(() => undefined);
  const apiError = getRecruitmentEventsApiError(responseBody);
  if (apiError !== undefined) {
    throw new Error(apiError);
  }
}

export function buildRecruitmentIdempotencyKey(
  prefix: string,
  parts: ReadonlyArray<string | number | boolean | undefined>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? "")))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:${hash}`;
}

export function recordRecruitmentEventAsync(
  event: RecruitmentEventDraft,
  logger: AgentLogger,
): void {
  const recording = (async () => {
    const recorder =
      recorderOverride ??
      (async (draft, draftLogger) => {
        await postRecruitmentEvent(draft, draftLogger, {
          ...DEFAULT_POST_DEPS,
          ...postDepsOverride,
        });
      });

    await recorder(event, logger);
  })();

  recording.catch((error: unknown) => {
    logger.warn(
      `Recruitment event tracking failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export function setRecruitmentEventRecorderForTests(
  recorder: RecruitmentEventRecorder | undefined,
): void {
  recorderOverride = recorder;
}

export function setRecruitmentEventPostDepsForTests(
  deps: Partial<RecruitmentEventPostDeps> | undefined,
): void {
  postDepsOverride = deps;
  missingConfigWarnings.clear();
}
