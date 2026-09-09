import { randomUUID } from "node:crypto";
import {
  BrowserScriptError,
  type BrowserExecuteInput,
  type BrowserExecuteResult,
  type BrowserScriptAction,
} from "./contracts.ts";
import { runBrowserScript } from "./script-runner.ts";

export interface BrowserProgramDriver {
  invoke(method: string, params: unknown[]): Promise<unknown>;
  readonly checks: Array<{
    passed: boolean;
    kind: string;
    elapsedMs: number;
    actual?: Record<string, unknown>;
  }>;
  readonly lastActionExecuted: boolean;
  readonly lastVerification: "not_requested" | "passed" | "failed";
  close(): void;
}

const mutations = new Set(["click", "fill", "hover", "press", "scroll", "goto", "choose"]);
const OUTPUT_LIMIT = 64 * 1024;

function observationUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value.url);
    const safe = url.origin + url.pathname;
    return safe.length <= 2048 ? safe : undefined;
  } catch {
    return undefined;
  }
}

function observationChanges(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const changes: string[] = [];
  for (const key of ["title", "focused"] as const) {
    const left = key in before ? (before as Record<string, unknown>)[key] : undefined;
    const right = key in after ? (after as Record<string, unknown>)[key] : undefined;
    if (typeof right === "string" && left !== right) changes.push(`${key}: ${right.slice(0, 160)}`);
  }
  const oldDialogs =
    "dialogs" in before && Array.isArray(before.dialogs)
      ? before.dialogs.filter((v): v is string => typeof v === "string").slice(0, 10)
      : [];
  const newDialogs =
    "dialogs" in after && Array.isArray(after.dialogs)
      ? after.dialogs.filter((v): v is string => typeof v === "string").slice(0, 10)
      : [];
  for (const name of newDialogs) {
    if (!oldDialogs.includes(name)) changes.push(`dialog appeared: ${name.slice(0, 160)}`);
  }
  for (const name of oldDialogs) {
    if (!newDialogs.includes(name)) changes.push(`dialog disappeared: ${name.slice(0, 160)}`);
  }
  return changes;
}

/** Runs once; terminal failures are values so callers never auto-replay a partially executed script. */
export async function executeBrowserProgram(
  input: BrowserExecuteInput,
  options: {
    driver: BrowserProgramDriver;
    signal?: AbortSignal;
    artifacts?: BrowserExecuteResult["artifacts"];
  },
): Promise<BrowserExecuteResult> {
  const started = performance.now();
  const { driver } = options;
  const actions: BrowserScriptAction[] = [];
  let lastMutation = -1;
  let lastVerified = -1;
  let helperCalls = 0;
  let beforeUrl: string | undefined;
  let afterUrl: string | undefined;
  let beforeObservation: unknown;
  let afterObservation: unknown;
  let value: unknown;
  let logs: string[] = [];
  let status: BrowserExecuteResult["status"] = "completed";
  let error: BrowserExecuteResult["error"];
  let preconditionChecks = 0;
  const abort = new AbortController();
  const onAbort = () => {
    abort.abort();
    driver.close();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(onAbort, input.timeoutMs);

  const invoke = async (method: string, params: unknown[]) => {
    if (abort.signal.aborted) {
      throw new BrowserScriptError("cancelled", "Browser execution stopped");
    }
    if (helperCalls >= input.maxCalls) {
      throw new BrowserScriptError("helper_limit", "Browser helper call limit reached");
    }
    helperCalls += 1;
    const action: BrowserScriptAction = {
      index: actions.length,
      method,
      executed: false,
      verification: "not_requested",
      elapsedMs: 0,
    };
    const began = performance.now();
    const checksBefore = driver.checks.length;
    actions.push(action);
    try {
      const result = await driver.invoke(method, params);
      action.executed = true;
      action.verification = driver.lastVerification;
      if (mutations.has(method)) lastMutation = action.index;
      if (driver.checks.slice(checksBefore).some((check) => check.passed)) {
        lastVerified = action.index;
      }
      return result;
    } catch (caught) {
      action.executed = driver.lastActionExecuted;
      action.verification = driver.lastVerification;
      action.errorCode = caught instanceof BrowserScriptError ? caught.code : "helper_failed";
      if (action.executed && mutations.has(method)) lastMutation = action.index;
      throw caught;
    } finally {
      action.elapsedMs = performance.now() - began;
    }
  };

  try {
    if (abort.signal.aborted) {
      throw new BrowserScriptError("cancelled", "Browser execution stopped");
    }
    beforeObservation = await driver.invoke("observe", []);
    beforeUrl = observationUrl(beforeObservation);
    for (const condition of input.preconditions) {
      await invoke("expect", [condition, { timeoutMs: 1000 }]);
    }
    preconditionChecks = driver.checks.length;
    lastVerified = -1;
    const remainingMs = Math.max(1, Math.floor(input.timeoutMs - (performance.now() - started)));
    const result = await runBrowserScript({
      source: input.source,
      args: input.args,
      timeoutMs: remainingMs,
      maxCalls: input.maxCalls,
      signal: abort.signal,
      invoke,
      onStop: () => driver.close(),
    });
    status = result.status;
    value = result.value;
    logs = result.logs;
    error = result.error;
    if (status === "completed") {
      for (const condition of input.postconditions) await invoke("expect", [condition]);
      afterObservation = await driver.invoke("observe", []);
      afterUrl = observationUrl(afterObservation);
    }
  } catch (caught) {
    status = "failed";
    error = {
      code: caught instanceof BrowserScriptError ? caught.code : "execution_failed",
      message:
        caught instanceof BrowserScriptError
          ? caught.message.slice(0, 200)
          : "Browser operation failed; inspect the last action and refresh observations",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    driver.close();
  }

  if (abort.signal.aborted) {
    status = options.signal?.aborted ? "cancelled" : "timed_out";
    error = { code: status, message: "Execution stopped; completed actions were not rolled back" };
  }
  const checks: BrowserExecuteResult["checks"] = driver.checks.map((check) => {
    const actual: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(check.actual ?? {}).slice(0, 10)) {
      if (typeof value === "string") actual[key] = value.slice(0, 500);
      else if (
        typeof value === "boolean" ||
        value === null ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        actual[key] = value;
      }
    }
    return {
      passed: check.passed,
      kind: check.kind.slice(0, 100),
      elapsedMs: check.elapsedMs,
      ...(check.actual ? { actual } : {}),
    };
  });
  const verifiedAssertions = checks
    .slice(preconditionChecks)
    .filter((check) => check.passed).length;
  const verification = checks.some((check) => !check.passed)
    ? "failed"
    : lastVerified >= 0 && lastVerified >= lastMutation
      ? "passed"
      : "not_requested";
  const changes = observationChanges(beforeObservation, afterObservation);
  const result: BrowserExecuteResult = {
    executionId: randomUUID(),
    status,
    verification,
    ...(value === undefined ? {} : { value }),
    logs,
    actions,
    checks,
    observation: {
      ...(beforeUrl === undefined ? {} : { beforeUrl }),
      ...(afterUrl === undefined ? {} : { afterUrl }),
      changed:
        changes.length > 0 ||
        (beforeUrl !== undefined && afterUrl !== undefined && beforeUrl !== afterUrl),
      changes,
    },
    artifacts: options.artifacts ?? [],
    ...(error === undefined
      ? {}
      : { error: { code: error.code.slice(0, 64), message: error.message.slice(0, 300) } }),
    metrics: { elapsedMs: performance.now() - started, helperCalls, verifiedAssertions },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT) {
    delete result.value;
    result.logs = [];
    result.status = "failed";
    result.error = {
      code: "output_limit",
      message: "Output exceeded 64KiB; result/logs omitted; inspect the retained action summary",
    };
    // Artifact content is out-of-band. Unbounded user-supplied fixture/driver metadata
    // must not defeat the public output budget either.
    result.artifacts = result.artifacts.slice(0, 100).map((artifact) => ({
      ...artifact,
      id: artifact.id.slice(0, 100),
      path: artifact.path.slice(0, 1000),
    }));
    while (
      Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT &&
      result.artifacts.length > 0
    ) {
      result.artifacts.pop();
    }
    while (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT && result.checks.length > 0) {
      result.checks.pop();
    }
    while (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT && result.actions.length > 0) {
      result.actions.pop();
    }
  }
  return result;
}
