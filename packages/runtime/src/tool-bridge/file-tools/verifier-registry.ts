import { execFile, spawnSync, type ExecFileException } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveFilePath } from "./file-io.ts";

export const VERIFIER_LEVELS = { fast: "fast", project: "project" } as const;
export type VerifierLevel = (typeof VERIFIER_LEVELS)[keyof typeof VERIFIER_LEVELS];

export interface VerifierCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

export interface Verifier {
  readonly id: string;
  readonly level: VerifierLevel;
  readonly detect: (workdir: string, filePath: string) => boolean;
  readonly command: (
    workdir: string,
    filePath: string,
  ) => VerifierCommand | "builtin-json" | "builtin-yaml";
  readonly timeoutMs: number;
}

export type VerifierOutcome =
  | { readonly id: string; readonly status: "pass" }
  | { readonly id: string; readonly status: "fail"; readonly output: string }
  | { readonly id: string; readonly status: "skipped"; readonly reason: string };

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
    return result.status === 0;
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
];

function hasEslintConfig(workdir: string): boolean {
  if (ESLINT_FLAT_CONFIG_FILES.some((name) => existsSync(join(workdir, name)))) {
    return true;
  }
  try {
    return readdirSync(workdir).some((entry) => entry.startsWith(".eslintrc"));
  } catch {
    return false;
  }
}

const ESLINT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TSC_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

const eslintVerifier: Verifier = {
  id: "eslint",
  level: VERIFIER_LEVELS.fast,
  detect: (workdir) => existsSync(localBinPath(workdir, "eslint")) && hasEslintConfig(workdir),
  command: (workdir, filePath) => ({
    bin: localBinPath(workdir, "eslint"),
    args: ["--no-fix", filePath],
  }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const tscVerifier: Verifier = {
  id: "tsc",
  level: VERIFIER_LEVELS.project,
  detect: (workdir) =>
    existsSync(localBinPath(workdir, "tsc")) && existsSync(join(workdir, "tsconfig.json")),
  command: (workdir) => ({ bin: localBinPath(workdir, "tsc"), args: ["--noEmit"] }),
  timeoutMs: PROJECT_TIMEOUT_MS,
};

const ruffVerifier: Verifier = {
  id: "ruff",
  level: VERIFIER_LEVELS.fast,
  detect: () => isBinaryOnPath("ruff"),
  command: (_workdir, filePath) => ({ bin: "ruff", args: ["check", "--no-fix", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const pyCompileVerifier: Verifier = {
  id: "py-compile",
  level: VERIFIER_LEVELS.fast,
  detect: () => !isBinaryOnPath("ruff") && isBinaryOnPath("python3"),
  command: (_workdir, filePath) => ({ bin: "python3", args: ["-m", "py_compile", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const jsonVerifier: Verifier = {
  id: "json",
  level: VERIFIER_LEVELS.fast,
  detect: () => true,
  command: () => "builtin-json",
  timeoutMs: FAST_TIMEOUT_MS,
};

const yamlVerifier: Verifier = {
  id: "yaml",
  level: VERIFIER_LEVELS.fast,
  detect: () => isYamlModuleAvailable(),
  command: () => "builtin-yaml",
  timeoutMs: FAST_TIMEOUT_MS,
};

const bashSyntaxVerifier: Verifier = {
  id: "bash-syntax",
  level: VERIFIER_LEVELS.fast,
  detect: () => isBinaryOnPath("bash"),
  command: (_workdir, filePath) => ({ bin: "bash", args: ["-n", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const gofmtVerifier: Verifier = {
  id: "gofmt",
  level: VERIFIER_LEVELS.fast,
  detect: () => isBinaryOnPath("gofmt"),
  command: (_workdir, filePath) => ({ bin: "gofmt", args: ["-l", filePath] }),
  timeoutMs: FAST_TIMEOUT_MS,
};

const goVetVerifier: Verifier = {
  id: "go-vet",
  level: VERIFIER_LEVELS.project,
  detect: (workdir) => existsSync(join(workdir, "go.mod")) && isBinaryOnPath("gofmt"),
  command: () => ({ bin: "go", args: ["vet", "./..."] }),
  timeoutMs: PROJECT_TIMEOUT_MS,
};

const cargoCheckVerifier: Verifier = {
  id: "cargo-check",
  level: VERIFIER_LEVELS.project,
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
  return {
    id: verifier.id,
    status: "fail",
    output: truncateOutput(combineStreams(stdout, stderr)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runBuiltinJson(verifier: Verifier, absolutePath: string): VerifierOutcome {
  try {
    JSON.parse(readFileSync(absolutePath, "utf8"));
    return { id: verifier.id, status: "pass" };
  } catch (error) {
    return { id: verifier.id, status: "fail", output: errorMessage(error) };
  }
}

async function runBuiltinYaml(verifier: Verifier, absolutePath: string): Promise<VerifierOutcome> {
  try {
    const { parse } = await import("yaml");
    parse(readFileSync(absolutePath, "utf8"));
    return { id: verifier.id, status: "pass" };
  } catch (error) {
    return { id: verifier.id, status: "fail", output: errorMessage(error) };
  }
}

function spawnErrorOutput(error: ExecFileException, timeoutMs: number): string {
  return error.killed === true
    ? `执行超时（超过 ${String(timeoutMs)}ms）：${error.message}`
    : error.message;
}

function runExternalCommand(
  verifier: Verifier,
  command: VerifierCommand,
  workdir: string,
): Promise<VerifierOutcome> {
  return new Promise((resolve) => {
    execFile(
      command.bin,
      command.args,
      { cwd: workdir, timeout: verifier.timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(outcomeFromExecution(verifier, 0, stdout, stderr));
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
          resolve(outcomeFromExecution(verifier, error.code, stdout, stderr));
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
): Promise<VerifierOutcome> {
  const absolutePath = resolveFilePath(workdir, filePath);
  const command = verifier.command(workdir, absolutePath);
  if (command === "builtin-json") {
    return runBuiltinJson(verifier, absolutePath);
  }
  if (command === "builtin-yaml") {
    return runBuiltinYaml(verifier, absolutePath);
  }
  return runExternalCommand(verifier, command, workdir);
}
