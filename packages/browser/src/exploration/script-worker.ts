import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSDeferredPromise, QuickJSHandle } from "quickjs-emscripten";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const port = parentPort;
  const data: unknown = workerData;
  if (
    !port ||
    !isRecord(data) ||
    typeof data.source !== "string" ||
    typeof data.argsJson !== "string" ||
    typeof data.timeoutMs !== "number" ||
    typeof data.memoryLimitBytes !== "number" ||
    typeof data.maxOutputBytes !== "number"
  ) {
    throw new Error("Invalid script worker configuration.");
  }
  const deadline = Date.now() + data.timeoutMs;
  const outputLimit = data.maxOutputBytes;
  const runtime = (await getQuickJS()).newRuntime();
  runtime.setMemoryLimit(data.memoryLimitBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  // No module loader, Node bindings, network clients or browser objects are installed.
  const vm = runtime.newContext();
  let done = false;
  let serializing = false;
  let nextId = 0;
  let outputBytes = 0;
  const pending = new Map<number, QuickJSDeferredPromise>();
  const fail = (code = "SCRIPT_ERROR"): void => {
    if (done) return;
    done = true;
    port.postMessage({ kind: "failure", code });
  };
  const drainJobs = (): void => {
    if (done) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      jobs.error.dispose();
      fail();
    }
  };

  const invoke = vm.newFunction("browserHelper", (method, json) => {
    if (done || !method || !json) return vm.undefined;
    if (serializing) {
      fail("UNAWAITED_HELPERS");
      return vm.undefined;
    }
    const deferred = vm.newPromise();
    const id = ++nextId;
    pending.set(id, deferred);
    port.postMessage({ kind: "call", id, method: vm.getString(method), json: vm.getString(json) });
    return deferred.handle;
  });
  const log = vm.newFunction("scriptLog", (json) => {
    if (done || !json) return vm.undefined;
    const text = vm.getString(json);
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > outputLimit) {
      fail("OUTPUT_LIMIT");
      return vm.undefined;
    }
    port.postMessage({ kind: "log", text });
    return vm.undefined;
  });
  vm.setProp(vm.global, "__browserHelper", invoke);
  vm.setProp(vm.global, "__scriptLog", log);
  invoke.dispose();
  log.dispose();

  // Only this fixed bootstrap accesses the host callbacks; user source is never interpolated.
  const bootstrap = vm.evalCode(
    `(() => {
    const invoke = globalThis.__browserHelper;
    const log = globalThis.__scriptLog;
    delete globalThis.__browserHelper;
    delete globalThis.__scriptLog;
    const stringify = JSON.stringify.bind(JSON);
    const parse = JSON.parse.bind(JSON);
    const page = Object.create(null);
    for (const method of ["observe", "snapshot", "read", "exists", "count", "click", "fill", "hover", "press", "scroll", "goto", "waitFor", "expect", "screenshot", "inspectControl", "choose"]) {
      page[method] = (...params) => invoke(method, stringify(params)).then(parse);
    }
    page.locator = (css, options = {}) => ({ ...options, css });
    page.getByRole = (role, options = {}) => ({ ...options, role });
    page.ref = (ref, snapshotId) => ({ ref, snapshotId });
    const logger = (...values) => log(stringify(values));
    Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: logger, info: logger, warn: logger, error: logger }), writable: false, configurable: false });
    return { page: Object.freeze(page), parse, stringify, AsyncFunction: (async function() {}).constructor };
  })()`,
    "browser-bootstrap.js",
  );
  if (bootstrap.error) {
    bootstrap.error.dispose();
    fail();
    return;
  }
  const globals = bootstrap.value;
  const constructor = vm.getProp(globals, "AsyncFunction");
  const argsName = vm.newString("args");
  const pageName = vm.newString("page");
  const source = vm.newString(data.source);
  // AsyncFunction receives the body as a value, so closing braces cannot escape into host code.
  const compiled = vm.callFunction(constructor, vm.undefined, argsName, pageName, source);
  constructor.dispose();
  argsName.dispose();
  pageName.dispose();
  source.dispose();
  if (compiled.error) {
    compiled.error.dispose();
    fail("COMPILE_ERROR");
    return;
  }
  if (data.compileOnly === true) {
    compiled.value.dispose();
    done = true;
    port.postMessage({ kind: "complete", json: "null" });
    return;
  }

  const parse = vm.getProp(globals, "parse");
  const argsJson = vm.newString(data.argsJson);
  const parsed = vm.callFunction(parse, vm.undefined, argsJson);
  parse.dispose();
  argsJson.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    compiled.value.dispose();
    fail();
    return;
  }
  const page = vm.getProp(globals, "page");
  const execution = vm.callFunction(compiled.value, vm.undefined, parsed.value, page);
  compiled.value.dispose();
  parsed.value.dispose();
  page.dispose();
  if (execution.error) {
    execution.error.dispose();
    fail();
    return;
  }
  const entry: QuickJSHandle = execution.value;

  port.on("message", (message: unknown) => {
    if (done) return;
    if (
      !isRecord(message) ||
      message.kind !== "reply" ||
      typeof message.id !== "number" ||
      typeof message.json !== "string"
    ) {
      fail();
      return;
    }
    const deferred = pending.get(message.id);
    if (!deferred) {
      fail();
      return;
    }
    pending.delete(message.id);
    const response = vm.newString(message.json);
    deferred.resolve(response);
    response.dispose();
    deferred.dispose();
    drainJobs();
  });

  const settled = vm.resolvePromise(entry);
  drainJobs();
  const completion = await settled;
  entry.dispose();
  if (done) {
    completion.dispose();
    return;
  }
  if (completion.error) {
    completion.error.dispose();
    fail();
    return;
  }
  if (pending.size > 0) {
    completion.value.dispose();
    fail("UNAWAITED_HELPERS");
    return;
  }
  const stringify = vm.getProp(globals, "stringify");
  // JSON.stringify may invoke getters/toJSON supplied by the script. Those may not start
  // browser work after the entry function has already completed.
  serializing = true;
  const serialized = vm.callFunction(stringify, vm.undefined, completion.value);
  stringify.dispose();
  completion.value.dispose();
  if (serialized.error) {
    serialized.error.dispose();
    fail();
    return;
  }
  if (done || pending.size > 0) {
    serialized.value.dispose();
    fail("UNAWAITED_HELPERS");
    return;
  }
  const json =
    vm.typeof(serialized.value) === "undefined" ? "null" : vm.getString(serialized.value);
  serialized.value.dispose();
  if (outputBytes + Buffer.byteLength(json) > outputLimit) {
    fail("OUTPUT_LIMIT");
    return;
  }
  done = true;
  port.postMessage({ kind: "complete", json });
}

main().catch(() => parentPort?.postMessage({ kind: "failure", code: "SCRIPT_ERROR" }));
