import { Worker } from "node:worker_threads";

export const BROWSER_SCRIPT_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const;

export interface BrowserScriptResult {
  status: (typeof BROWSER_SCRIPT_STATUSES)[number];
  value?: unknown;
  logs: string[];
  error?: { code: string; message: string };
  callCount: number;
  elapsedMs: number;
}

export interface BrowserScriptOptions {
  source: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  maxCalls?: number;
  memoryLimitBytes?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  invoke: (method: string, params: unknown[]) => Promise<unknown>;
  onStop?: () => void;
}

const helperNames = new Set([
  "inspectControl",
  "choose",
  "observe",
  "snapshot",
  "read",
  "exists",
  "count",
  "click",
  "fill",
  "hover",
  "press",
  "scroll",
  "goto",
  "waitFor",
  "expect",
  "screenshot",
]);

const defaults = {
  timeoutMs: 30_000,
  maxCalls: 100,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxOutputBytes: 64 * 1024,
} as const;

function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("Script limits must be positive integers no greater than their defaults.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh interpreter and approval lifetime for each run. No host objects enter QuickJS. */
export async function runBrowserScript(
  options: BrowserScriptOptions,
): Promise<BrowserScriptResult> {
  return runWorker(options, false);
}

/** Constructs an async function in QuickJS without calling it, including for hostile source. */
export async function compileBrowserScript(
  source: string,
): Promise<{ valid: boolean; error?: string }> {
  const result = await runWorker({ source, invoke: async () => null }, true);
  return result.status === "completed"
    ? { valid: true }
    : { valid: false, error: result.error?.message ?? "Script compilation failed." };
}

async function runWorker(
  options: BrowserScriptOptions,
  compileOnly: boolean,
): Promise<BrowserScriptResult> {
  const started = performance.now();
  const logs: string[] = [];
  let callCount = 0;
  let outputBytes = 0;
  const result = (
    status: BrowserScriptResult["status"],
    error?: BrowserScriptResult["error"],
    value?: unknown,
  ): BrowserScriptResult => ({
    status,
    logs,
    callCount,
    elapsedMs: performance.now() - started,
    ...(error ? { error } : {}),
    ...(value === undefined ? {} : { value }),
  });
  if (options.signal?.aborted) {
    return result("cancelled", { code: "CANCELLED", message: "Script execution was cancelled." });
  }
  let limits: typeof defaults | { [K in keyof typeof defaults]: number };
  let argsJson: string;
  try {
    limits = {
      timeoutMs: boundedLimit(options.timeoutMs, defaults.timeoutMs),
      maxCalls: boundedLimit(options.maxCalls, defaults.maxCalls),
      memoryLimitBytes: boundedLimit(options.memoryLimitBytes, defaults.memoryLimitBytes),
      maxOutputBytes: boundedLimit(options.maxOutputBytes, defaults.maxOutputBytes),
    };
    argsJson = JSON.stringify(options.args ?? {});
    if (Buffer.byteLength(options.source) > 256 * 1024 || Buffer.byteLength(argsJson) > 64 * 1024) {
      throw new Error("Script input exceeds the allowed size.");
    }
  } catch {
    return result("failed", { code: "INVALID_INPUT", message: "Invalid script input or limits." });
  }

  let worker: Worker;
  try {
    worker = new Worker(
      new URL(import.meta.resolve("@roll-agent/browser/exploration/script-worker")),
      {
        workerData: { source: options.source, argsJson, compileOnly, ...limits },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        // Worker uses a real file even when its caller was started with node --input-type.
        execArgv: ["--experimental-strip-types"],
      },
    );
  } catch {
    return result("failed", {
      code: "WORKER_UNAVAILABLE",
      message: "Script worker could not start.",
    });
  }

  return new Promise<BrowserScriptResult>((resolve) => {
    // The latch is outside the interpreter: catching a rejected helper cannot reset it.
    let terminal = false;
    let queue: Promise<void> = Promise.resolve();
    let lastId = 0;
    let outstanding = 0;
    const finish = (
      status: BrowserScriptResult["status"],
      error?: BrowserScriptResult["error"],
      value?: unknown,
    ): void => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (status !== "completed") {
        try {
          options.onStop?.();
        } catch {
          /* Cleanup must not replace the terminal reason. */
        }
      }
      const stopped = worker.terminate().catch(() => undefined);
      // A host action may already have started. Never release the caller's browser lock early.
      Promise.allSettled([queue, stopped]).then(() => resolve(result(status, error, value)));
    };
    const fail = (code: string, message: string): void => finish("failed", { code, message });
    const abort = (): void =>
      finish("cancelled", { code: "CANCELLED", message: "Script execution was cancelled." });
    const timer = setTimeout(
      () =>
        finish("timed_out", {
          code: "TIMEOUT",
          message: "Script execution exceeded its deadline.",
        }),
      limits.timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on("error", () => fail("WORKER_ERROR", "Script worker failed or exhausted resources."));
    worker.on("exit", () => {
      if (!terminal) fail("WORKER_EXIT", "Script worker exited without a result.");
    });
    worker.on("message", (message: unknown) => {
      if (terminal) return;
      if (!isRecord(message)) {
        fail("WORKER_PROTOCOL", "Invalid script worker message.");
        return;
      }
      if (message.kind === "log" && typeof message.text === "string") {
        outputBytes += Buffer.byteLength(message.text);
        if (outputBytes > limits.maxOutputBytes) {
          fail("OUTPUT_LIMIT", "Script output exceeded its limit.");
          return;
        }
        logs.push(message.text);
        return;
      }
      if (message.kind === "failure") {
        // Error text from user source, page data and callbacks must never leak through exceptions.
        const code =
          message.code === "COMPILE_ERROR"
            ? "COMPILE_ERROR"
            : message.code === "UNAWAITED_HELPERS"
              ? "UNAWAITED_HELPERS"
              : message.code === "OUTPUT_LIMIT"
                ? "OUTPUT_LIMIT"
                : "SCRIPT_ERROR";
        fail(
          code,
          code === "COMPILE_ERROR"
            ? "Script is not a valid async function body."
            : "Script failed; no further browser actions were run.",
        );
        return;
      }
      if (message.kind === "complete" && typeof message.json === "string") {
        if (outstanding > 0) {
          fail("UNAWAITED_HELPERS", "Script completed while browser helpers were still running.");
          return;
        }
        outputBytes += Buffer.byteLength(message.json);
        if (outputBytes > limits.maxOutputBytes) {
          fail("OUTPUT_LIMIT", "Script output exceeded its limit.");
          return;
        }
        try {
          finish("completed", undefined, JSON.parse(message.json));
        } catch {
          fail("WORKER_PROTOCOL", "Invalid script result.");
        }
        return;
      }
      if (
        message.kind !== "call" ||
        !Number.isSafeInteger(message.id) ||
        typeof message.id !== "number" ||
        message.id !== lastId + 1 ||
        typeof message.method !== "string" ||
        !helperNames.has(message.method) ||
        typeof message.json !== "string" ||
        Buffer.byteLength(message.json) > 64 * 1024 ||
        compileOnly
      ) {
        fail("WORKER_PROTOCOL", "Invalid browser helper request.");
        return;
      }
      const { id, method, json } = message;
      lastId = id;
      let params: unknown;
      try {
        params = JSON.parse(json);
      } catch {
        fail("INVALID_HELPER_INPUT", "Invalid browser helper input.");
        return;
      }
      if (!Array.isArray(params)) {
        fail("INVALID_HELPER_INPUT", "Invalid browser helper input.");
        return;
      }
      const callParams: unknown[] = params;
      if (lastId > limits.maxCalls) {
        fail("CALL_LIMIT", "Script exceeded its browser helper call limit.");
        return;
      }
      outstanding += 1;
      queue = queue.then(async () => {
        if (terminal) return;
        callCount += 1;
        try {
          const value = await options.invoke(method, callParams);
          if (terminal) return;
          const response = JSON.stringify(value ?? null);
          // Screenshots belong in host artifacts, never as unbounded data in the interpreter.
          if (Buffer.byteLength(response) > limits.maxOutputBytes) {
            fail("HELPER_RESULT_LIMIT", "Browser helper result exceeded its transfer limit.");
            return;
          }
          outstanding -= 1;
          worker.postMessage({ kind: "reply", id, json: response });
        } catch (error) {
          const code =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code)
              ? error.code
              : "HELPER_FAILED";
          fail(code, "Browser helper failed; execution stopped.");
        }
      });
    });
  });
}
