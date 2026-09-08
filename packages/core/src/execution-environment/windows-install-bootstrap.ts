import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  acquireDistributionLock,
  distributionTreeDigest,
  distributionVersionSchema,
  retryWindowsFileOperation,
  smokeDistribution,
  type PreparedDistribution,
} from "./distribution.ts";
import { resolveExecutionEnvironment, type ExecutionEnvironment } from "./index.ts";
import { extractWindowsZip } from "./windows-zip.ts";
import { WINDOWS_LAUNCHER } from "./windows-launcher.ts";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && !/[\r\n\0]/.test(value));
export const windowsInstallRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    installRoot: absolutePath,
    archive: absolutePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 ** 3),
    version: distributionVersionSchema,
    platform: z.enum(["win32-x64", "win32-arm64"]),
    resultPath: absolutePath,
  })
  .strict();
export type WindowsInstallRequest = z.infer<typeof windowsInstallRequestSchema>;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function existing(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing installation reparse point: ${path}`);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Check every existing parent before creating or writing in the install tree. */
async function assertParents(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    if (await existing(cursor)) {
      if (!(await lstat(cursor)).isDirectory()) throw new Error(`Not a directory: ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function verifyArchive(request: WindowsInstallRequest, signal: AbortSignal): Promise<void> {
  const info = await lstat(request.archive);
  if (!info.isFile() || info.size !== request.size) throw new Error("Asset size/type mismatch");
  const hash = createHash("sha256");
  const stream = createReadStream(request.archive, { signal });
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest("hex") !== request.sha256) throw new Error("Asset checksum mismatch");
}

async function atomicText(path: string, value: string): Promise<void> {
  await existing(path);
  const temporary = join(dirname(path), `.roll-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await retryWindowsFileOperation(() => rename(temporary, path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Bootstrap must execute outside the version directory that it may move. */
export async function installWindowsDistribution(
  input: unknown,
  options: {
    readonly signal?: AbortSignal;
    readonly smoke?: typeof smokeDistribution;
    readonly acquireLock?: typeof acquireDistributionLock;
  } = {},
): Promise<{
  schemaVersion: 1;
  version: string;
  launcher: string;
  installRoot: string;
  warnings: readonly string[];
}> {
  const request = windowsInstallRequestSchema.parse(input);
  const signal = options.signal ?? new AbortController().signal;
  const root = resolve(request.installRoot);
  if (root === parse(root).root) throw new Error("InstallDir cannot be a filesystem root");
  signal.throwIfAborted();
  console.error("roll installer: verifying archive");
  await verifyArchive(request, signal);
  await assertParents(root);
  await mkdir(root, { recursive: true });
  const markerPath = join(root, "installation.json");
  let hasMarker = await existing(markerPath);
  if (!hasMarker && (await readdir(root)).length !== 0) {
    throw new Error("InstallDir is not empty and is not a Roll standalone installation");
  }
  const releaseLock = await (options.acquireLock ?? acquireDistributionLock)(root);
  let scratch: string | undefined;
  let createdTarget: string | undefined;
  let createdVersions = false;
  let createdBin = false;
  let wroteMarker = false;
  let wroteLauncher = false;
  let activated = false;
  let rollbackFailed = false;
  const cleanup = async () => {
    try {
      if (scratch) {
        await retryWindowsFileOperation(() => rm(scratch!, { recursive: true, force: true }));
      }
    } catch (error) {
      throw new Error(`Installer cleanup failed; lock retained. Scratch: ${scratch}`, {
        cause: error,
      });
    }
    if (!rollbackFailed) await releaseLock();
  };
  try {
    // Another installer may have completed between the initial inspection and lock acquisition.
    // Only observations made while holding our lock may choose fresh vs. maintenance activation.
    hasMarker = await existing(markerPath);
    if (!hasMarker && (await readdir(root)).some((name) => name !== ".install-lock")) {
      throw new Error(
        "InstallDir changed before lock acquisition; refusing an unknown installation",
      );
    }
    let oldVersion: string | undefined;
    if (hasMarker) {
      if (!(await lstat(markerPath)).isFile()) throw new Error("Invalid installation metadata");
      z.object({ schemaVersion: z.literal(1), channel: z.literal("standalone") })
        .strict()
        .parse(JSON.parse(await readFile(markerPath, "utf8")));
      const pointer = join(root, "current.txt");
      if (!(await existing(pointer)) || !(await lstat(pointer)).isFile()) {
        throw new Error("Invalid installation pointer; refusing to guess the active version");
      }
      oldVersion = distributionVersionSchema.parse((await readFile(pointer, "utf8")).trim());
    }
    scratch = await mkdtemp(join(root, ".i-"));
    const candidate = join(scratch, "candidate");
    console.error("roll installer: validating and extracting ZIP");
    await extractWindowsZip(request.archive, candidate, signal);
    const candidateEnvironment = resolveExecutionEnvironment({
      packageRoot: join(candidate, "app"),
    });
    if (
      candidateEnvironment.installation.version !== request.version ||
      candidateEnvironment.installation.platform !== request.platform
    ) {
      throw new Error("Distribution identity mismatch");
    }
    const metadata = z
      .object({ nodeVersion: z.string() })
      .parse(JSON.parse(await readFile(join(candidate, "distribution.json"), "utf8")));
    if (metadata.nodeVersion !== process.versions.node) {
      throw new Error("Bootstrap Node version mismatch");
    }
    const home = join(scratch, "home");
    await mkdir(home);
    console.error("roll installer: checking private runtime and CLI");
    await (options.smoke ?? smokeDistribution)(candidateEnvironment, home, signal);
    signal.throwIfAborted();
    const versions = join(root, "versions");
    await assertParents(versions);
    createdVersions = !(await existing(versions));
    await mkdir(versions, { recursive: true });
    const target = join(versions, request.version);
    if (await existing(target)) {
      if ((await distributionTreeDigest(target)) !== (await distributionTreeDigest(candidate))) {
        throw new Error("Existing version differs from verified release; refusing to overwrite");
      }
    } else {
      await retryWindowsFileOperation(async () => {
        signal.throwIfAborted();
        if (await existing(target)) {
          throw new Error("Version destination appeared during installation");
        }
        await rename(candidate, target);
        createdTarget = target;
      });
    }
    // Load coordination from its permanent location, so post-activation lazy imports stay valid.
    const next = resolveExecutionEnvironment({ packageRoot: join(target, "app") });
    const bin = join(root, "bin");
    await assertParents(bin);
    createdBin = !(await existing(bin));
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, "roll.cmd");
    const hadLauncher = await existing(launcher);
    if (hadLauncher && (await readFile(launcher, "utf8")) !== WINDOWS_LAUNCHER) {
      throw new Error("Existing launcher belongs to another installation");
    }
    const prepared: PreparedDistribution = {
      version: request.version,
      async activate() {
        signal.throwIfAborted();
        if (
          oldVersion !== undefined &&
          (await readFile(join(root, "current.txt"), "utf8")).trim() !== oldVersion
        ) {
          throw new Error("Active Roll version changed during installation");
        }
        if (!hadLauncher) {
          await writeFile(launcher, WINDOWS_LAUNCHER, { flag: "wx" });
          wroteLauncher = true;
        }
        if (!hasMarker) {
          await atomicText(markerPath, '{"schemaVersion":1,"channel":"standalone"}\n');
          wroteMarker = true;
        }
        await atomicText(join(root, "current.txt"), `${request.version}\n`);
        activated = true;
        return next;
      },
      async dispose() {}, // The bootstrap owns the installation lock and scratch lifetime.
    };
    let warnings: readonly string[] = [];
    console.error("roll installer: checking maintenance admission and activating");
    if (oldVersion !== undefined) {
      const current = resolveExecutionEnvironment({
        packageRoot: join(versions, oldVersion, "app"),
      });
      const module: unknown = await import(
        pathToFileURL(join(target, "app/dist/cli/commands/update.js")).href
      );
      if (
        typeof module !== "object" ||
        module === null ||
        !("activateInstallerDistribution" in module) ||
        typeof module.activateInstallerDistribution !== "function"
      ) {
        throw new Error("Distribution is missing installer maintenance coordination");
      }
      const coordinate = module.activateInstallerDistribution as (
        current: ExecutionEnvironment,
        prepared: PreparedDistribution,
      ) => Promise<{ environment: ExecutionEnvironment; warnings: readonly string[] }>;
      ({ warnings } = await coordinate(current, prepared));
    } else {
      await prepared.activate();
    }
    for (const warning of warnings) console.error(`roll installer: ${warning}`);
    return { schemaVersion: 1, version: request.version, launcher, installRoot: root, warnings };
  } catch (error) {
    // A fresh failed install must be retryable. Remove only objects created by this attempt;
    // never clear the installation root or an existing version. Active versions are retained.
    try {
      if (!hasMarker && !activated) {
        if (wroteLauncher) await rm(join(root, "bin/roll.cmd"));
        if (wroteMarker) await rm(markerPath);
        if (createdTarget) {
          await retryWindowsFileOperation(() => rm(createdTarget!, { recursive: true }));
        }
        if (createdBin) await rmdir(join(root, "bin"));
        if (createdVersions) await rmdir(join(root, "versions"));
      }
    } catch (cleanupError) {
      rollbackFailed = true;
      throw new AggregateError(
        [error, cleanupError],
        `Installer recovery failed; lock retained in ${root}`,
      );
    }
    throw error;
  } finally {
    // Cleanup failure deliberately retains owner.json and the lock for diagnosis.
    await cleanup();
  }
}
