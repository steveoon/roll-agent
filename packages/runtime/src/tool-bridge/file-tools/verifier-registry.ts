import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { loadTextFile, resolveFilePath } from "./file-io.ts";

export const VERIFIER_LEVELS = { fast: "fast", project: "project" } as const;
export type VerifierLevel = (typeof VERIFIER_LEVELS)[keyof typeof VERIFIER_LEVELS];

export interface VerifierCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

export interface Verifier {
  readonly id: string;
  readonly level: VerifierLevel;
  readonly executesProjectCode: boolean;
  readonly detect: (workdir: string, filePath: string) => boolean;
  readonly command: (
    workdir: string,
    filePath: string,
  ) => VerifierCommand | "builtin-json" | "builtin-yaml";
  readonly timeoutMs: number;
}

export type VerifierOutcome =
  | { readonly id: string; readonly status: "pass"; readonly detail?: string }
  | { readonly id: string; readonly status: "fail"; readonly output: string }
  | { readonly id: string; readonly status: "skipped"; readonly reason: string }
  | { readonly id: string; readonly status: "cancelled" };

const FAST_TIMEOUT_MS = 10_000;
const PROJECT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_BUFFER_BYTES = 512 * 1024;
const PATH_PROBE_TIMEOUT_MS = 3000;

export type BinaryProbe = (bin: string) => boolean;

const pathBinaryCache = new Map<string, boolean>();

function defaultBinaryProbe(bin: string): boolean {
  try {
    const result = spawnSync(bin, ["--version"], { timeout: PATH_PROBE_TIMEOUT_MS });
    return result.error === undefined;
  } catch {
    return false;
  }
}

export function isBinaryOnPath(bin: string, probe: BinaryProbe = defaultBinaryProbe): boolean {
  const cached = pathBinaryCache.get(bin);
  if (cached !== undefined) {
    return cached;
  }
  const detected = probe(bin);
  pathBinaryCache.set(bin, detected);
  return detected;
}

let yamlAvailableCache: boolean | undefined;

function isYamlModuleAvailable(): boolean {
  if (yamlAvailableCache !== undefined) {
    return yamlAvailableCache;
  }
  try {
    import.meta.resolve("yaml");
    yamlAvailableCache = true;
  } catch {
    yamlAvailableCache = false;
  }
  return yamlAvailableCache;
}

function localBinPath(workdir: string, name: string): string {
  return join(workdir, "node_modules", ".bin", name);
}

const ESLINT_FLAT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
] as const;

const ESLINT_LEGACY_CONFIG_FILES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
] as const;

function packageJsonHasEslintConfig(workdir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(workdir, "package.json"), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "eslintConfig" in parsed
    );
  } catch {
    return false;
  }
}

function hasEslintConfig(workdir: string): boolean {
  if (ESLINT_FLAT_CONFIG_FILES.some((name) => existsSync(join(workdir, name)))) {
    return true;
  }
  if (ESLINT_LEGACY_CONFIG_FILES.some((name) => existsSync(join(workdir, name)))) {
    return true;
  }
  return packageJsonHasEslintConfig(workdir);
}

const ESLINT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TSC_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

const PY_COMPILE_INLINE = [
  "-I",
  "-c",
  "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')",
] as const;

const eslintVerifier: Verifier = {
  id: "eslint",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: true,
  detect: (workdir) => existsSync(localBinPath(workdir, "eslint")) && hasEslintConfig(workdir),
  command: (workdir, filePath) => ({
    bin: localBinPath(workdir, "eslint"),
    args: ["--no-fix", "--format", "json", filePath],
  }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const tscVerifier: Verifier = {
  id: "tsc",
  level: VERIFIER_LEVELS.project,
  executesProjectCode: true,
  detect: (workdir) =>
    existsSync(localBinPath(workdir, "tsc")) && existsSync(join(workdir, "tsconfig.json")),
  command: (workdir) => ({ bin: localBinPath(workdir, "tsc"), args: ["--noEmit"] }),
  timeoutMs: PROJECT_TIMEOUT_MS,
};

const ruffVerifier: Verifier = {
  id: "ruff",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => isBinaryOnPath("ruff"),
  command: (_workdir, filePath) => ({ bin: "ruff", args: ["check", "--no-fix", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const pyCompileVerifier: Verifier = {
  id: "py-compile",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => !isBinaryOnPath("ruff") && isBinaryOnPath("python3"),
  command: (_workdir, filePath) => ({
    bin: "python3",
    args: [...PY_COMPILE_INLINE, filePath],
  }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const jsonVerifier: Verifier = {
  id: "json",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => true,
  command: () => "builtin-json",
  timeoutMs: FAST_TIMEOUT_MS,
};

const yamlVerifier: Verifier = {
  id: "yaml",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => isYamlModuleAvailable(),
  command: () => "builtin-yaml",
  timeoutMs: FAST_TIMEOUT_MS,
};

const bashSyntaxVerifier: Verifier = {
  id: "bash-syntax",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => isBinaryOnPath("bash"),
  command: (_workdir, filePath) => ({ bin: "bash", args: ["-n", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const gofmtVerifier: Verifier = {
  id: "gofmt",
  level: VERIFIER_LEVELS.fast,
  executesProjectCode: false,
  detect: () => isBinaryOnPath("gofmt"),
  command: (_workdir, filePath) => ({ bin: "gofmt", args: ["-l", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const goVetVerifier: Verifier = {
  id: "go-vet",
  level: VERIFIER_LEVELS.project,
  executesProjectCode: true,
  detect: (workdir) => existsSync(join(workdir, "go.mod")) && isBinaryOnPath("go"),
  command: () => ({ bin: "go", args: ["vet", "./..."] }),
  timeoutMs: PROJECT_TIMEOUT_MS,
};

const cargoCheckVerifier: Verifier = {
  id: "cargo-check",
  level: VERIFIER_LEVELS.project,
  executesProjectCode: true,
  detect: (workdir) => existsSync(join(workdir, "Cargo.toml")) && isBinaryOnPath("cargo"),
  command: () => ({ bin: "cargo", args: ["check", "--quiet"] }),
  timeoutMs: PROJECT_TIMEOUT_MS,
};

interface VerifierRegistryEntry {
  readonly extensions: readonly string[];
  readonly verifier: Verifier;
}

const VERIFIER_REGISTRY: readonly VerifierRegistryEntry[] = [
  { extensions: ESLINT_EXTENSIONS, verifier: eslintVerifier },
  { extensions: TSC_EXTENSIONS, verifier: tscVerifier },
  { extensions: [".py"], verifier: ruffVerifier },
  { extensions: [".py"], verifier: pyCompileVerifier },
  { extensions: [".json"], verifier: jsonVerifier },
  { extensions: [".yaml", ".yml"], verifier: yamlVerifier },
  { extensions: [".sh", ".bash"], verifier: bashSyntaxVerifier },
  { extensions: [".go"], verifier: gofmtVerifier },
  { extensions: [".go"], verifier: goVetVerifier },
  { extensions: [".rs"], verifier: cargoCheckVerifier },
];

export function verifiersForFile(filePath: string): readonly Verifier[] {
  const ext = extname(filePath).toLowerCase();
  return VERIFIER_REGISTRY.filter((entry) => entry.extensions.includes(ext)).map(
    (entry) => entry.verifier,
  );
}

function combineStreams(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((part) => part.length > 0).join("\n");
}

function truncateOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(输出已截断)`
    : text;
}

export function outcomeFromExecution(
  verifier: Verifier,
  exitCode: number,
  stdout: string,
  stderr: string,
): VerifierOutcome {
  const gofmtDirty = verifier.id === "gofmt" && exitCode === 0 && stdout.trim().length > 0;
  if (exitCode === 0 && !gofmtDirty) {
    return { id: verifier.id, status: "pass" };
  }
  const combined = combineStreams(stdout, stderr);
  return {
    id: verifier.id,
    status: "fail",
    output: combined.length > 0 ? truncateOutput(combined) : `退出码 ${String(exitCode)}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runBuiltinJson(
  verifier: Verifier,
  absolutePath: string,
  maxFileBytes: number,
): VerifierOutcome {
  const loaded = loadTextFile(absolutePath, { maxFileBytes });
  if (!loaded.ok) {
    return { id: verifier.id, status: "fail", output: loaded.message };
  }
  try {
    JSON.parse(loaded.content);
    return { id: verifier.id, status: "pass" };
  } catch (error) {
    return { id: verifier.id, status: "fail", output: errorMessage(error) };
  }
}

async function runBuiltinYaml(
  verifier: Verifier,
  absolutePath: string,
  maxFileBytes: number,
): Promise<VerifierOutcome> {
  const loaded = loadTextFile(absolutePath, { maxFileBytes });
  if (!loaded.ok) {
    return { id: verifier.id, status: "fail", output: loaded.message };
  }
  try {
    const { parse } = await import("yaml");
    parse(loaded.content);
    return { id: verifier.id, status: "pass" };
  } catch (error) {
    return { id: verifier.id, status: "fail", output: errorMessage(error) };
  }
}

const ESLINT_IGNORED_REASON = "文件被 eslint 配置忽略，未实际检查";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eslintMessageLooksIgnored(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.ruleId === null &&
    typeof message.message === "string" &&
    message.message.startsWith("File ignored")
  );
}

function parseEslintJson(stdout: string): readonly unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatEslintMessageLine(message: Record<string, unknown>): string | undefined {
  if (typeof message.message !== "string") {
    return undefined;
  }
  const line = typeof message.line === "number" ? message.line : 0;
  const column = typeof message.column === "number" ? message.column : 0;
  const severity = message.fatal === true || message.severity === 2 ? "error" : "warning";
  const ruleSuffix = typeof message.ruleId === "string" ? ` (${message.ruleId})` : "";
  return `${String(line)}:${String(column)} ${severity} ${message.message}${ruleSuffix}`;
}

function formatEslintFailOutput(parsed: readonly unknown[]): string | undefined {
  const lines: string[] = [];
  for (const file of parsed) {
    if (!isRecord(file) || !Array.isArray(file.messages)) {
      continue;
    }
    for (const message of file.messages) {
      if (!isRecord(message)) {
        continue;
      }
      const line = formatEslintMessageLine(message);
      if (line !== undefined) {
        lines.push(line);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function interpretEslintOutcome(
  verifier: Verifier,
  exitCode: number,
  stdout: string,
  stderr: string,
): VerifierOutcome {
  const parsed = parseEslintJson(stdout);
  if (parsed === undefined) {
    const combined = combineStreams(stdout, stderr);
    if (combined.includes("File ignored because of a matching ignore pattern")) {
      return { id: verifier.id, status: "skipped", reason: ESLINT_IGNORED_REASON };
    }
    return outcomeFromExecution(verifier, exitCode, stdout, stderr);
  }
  if (parsed.length === 0) {
    return { id: verifier.id, status: "skipped", reason: ESLINT_IGNORED_REASON };
  }
  const first = parsed[0];
  if (
    isRecord(first) &&
    Array.isArray(first.messages) &&
    first.messages.some(eslintMessageLooksIgnored)
  ) {
    return { id: verifier.id, status: "skipped", reason: ESLINT_IGNORED_REASON };
  }
  if (exitCode === 0) {
    const warningCount =
      isRecord(first) && typeof first.warningCount === "number" ? first.warningCount : 0;
    return warningCount > 0
      ? { id: verifier.id, status: "pass", detail: `${String(warningCount)} 个 warning` }
      : { id: verifier.id, status: "pass" };
  }
  const readable = formatEslintFailOutput(parsed);
  return {
    id: verifier.id,
    status: "fail",
    output: readable !== undefined ? truncateOutput(readable) : `退出码 ${String(exitCode)}`,
  };
}

function spawnErrorOutput(error: ExecFileException, timeoutMs: number): string {
  return error.killed === true
    ? `执行超时（超过 ${String(timeoutMs)}ms）：${error.message}`
    : error.message;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ABORT_ERR")
  );
}

function finishExternalOutcome(
  verifier: Verifier,
  exitCode: number,
  stdout: string,
  stderr: string,
): VerifierOutcome {
  return verifier.id === "eslint"
    ? interpretEslintOutcome(verifier, exitCode, stdout, stderr)
    : outcomeFromExecution(verifier, exitCode, stdout, stderr);
}

function runExternalCommand(
  verifier: Verifier,
  command: VerifierCommand,
  workdir: string,
  abortSignal: AbortSignal | undefined,
): Promise<VerifierOutcome> {
  return new Promise((resolve) => {
    execFile(
      command.bin,
      command.args,
      {
        cwd: workdir,
        timeout: verifier.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
        ...(abortSignal ? { signal: abortSignal } : {}),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(finishExternalOutcome(verifier, 0, stdout, stderr));
          return;
        }
        if (isAbortError(error) || abortSignal?.aborted === true) {
          resolve({ id: verifier.id, status: "cancelled" });
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({
            id: verifier.id,
            status: "fail",
            output: truncateOutput(combineStreams(stdout, stderr)),
          });
          return;
        }
        if (typeof error.code === "number") {
          resolve(finishExternalOutcome(verifier, error.code, stdout, stderr));
          return;
        }
        resolve({
          id: verifier.id,
          status: "fail",
          output: spawnErrorOutput(error, verifier.timeoutMs),
        });
      },
    );
  });
}

export async function runVerifier(
  verifier: Verifier,
  workdir: string,
  filePath: string,
  options: { readonly maxFileBytes?: number; readonly abortSignal?: AbortSignal } = {},
): Promise<VerifierOutcome> {
  const absolutePath = resolveFilePath(workdir, filePath);
  const command = verifier.command(workdir, absolutePath);
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  if (command === "builtin-json") {
    return runBuiltinJson(verifier, absolutePath, maxFileBytes);
  }
  if (command === "builtin-yaml") {
    return runBuiltinYaml(verifier, absolutePath, maxFileBytes);
  }
  return runExternalCommand(verifier, command, workdir, options.abortSignal);
}
