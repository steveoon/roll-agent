import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { join, posix } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  lstat,
  readdir,
  open,
  rmdir,
  unlink,
} from "node:fs/promises";
import { z } from "zod";
import { resolveExecutionEnvironment, type ExecutionEnvironment } from "./index.ts";

export const DISTRIBUTION_ORIGIN = "https://roll.duliday.com";
export const distributionVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
export const distributionPlatformSchema = z.enum([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
]);
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const assetSchema = z
  .object({
    platform: distributionPlatformSchema,
    filename: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  })
  .strict();
export const distributionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: distributionVersionSchema,
    nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    assets: z.array(assetSchema).min(1).max(6),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const asset of manifest.assets) {
      const extension = asset.platform.startsWith("win32-") ? "zip" : "tar.gz";
      if (
        asset.filename !== `roll-${manifest.version}-${asset.platform}.${extension}` ||
        seen.has(asset.platform)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid or duplicate distribution asset",
        });
      }
      seen.add(asset.platform);
    }
  });
export type DistributionManifest = z.infer<typeof distributionManifestSchema>;
export type DistributionAsset = z.infer<typeof assetSchema>;
const execFilePromise = promisify(execFile);
async function execFileAsync(command: string, args: string[], options: ExecFileOptions) {
  const pending = execFilePromise(command, args, { ...options, encoding: "utf8" });
  const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
  try {
    return await pending;
  } finally {
    await closed;
  }
}

export function selectDistributionAsset(
  manifest: DistributionManifest,
  platform: string,
): DistributionAsset {
  const asset = manifest.assets.find((item) => item.platform === platform);
  if (!asset) {
    throw new Error(`Roll ${manifest.version} has no verified distribution for ${platform}`);
  }
  return asset;
}

export async function fetchDistributionManifest(
  options: {
    readonly version?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Promise<DistributionManifest> {
  const version =
    options.version === undefined ? "stable" : distributionVersionSchema.parse(options.version);
  const response = await (options.fetch ?? globalThis.fetch)(
    `${DISTRIBUTION_ORIGIN}/releases/${version}/manifest.json`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    },
  );
  if (!response.ok) throw new Error(`Roll distribution manifest HTTP ${response.status}`);
  const bytes = await readBoundedBody(response, 64 * 1024);
  const manifest = distributionManifestSchema.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (version !== "stable" && manifest.version !== version) {
    throw new Error("Roll distribution version mismatch");
  }
  return manifest;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty distribution response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Distribution response exceeds size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface PreparedDistribution {
  readonly version: string;
  /** Called only while the existing scheduler/Agent maintenance guards are held. */
  activate(): Promise<ExecutionEnvironment>;
  dispose(): Promise<void>;
}

export class DistributionUpdateInterruptedError extends Error {
  readonly exitCode: number;
  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`Roll update interrupted by ${signal}`);
    this.name = "DistributionUpdateInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

/** Download and smoke-test before acquiring Agent maintenance locks or changing current.txt. */
export async function prepareDistributionUpdate(
  current: ExecutionEnvironment,
  input: DistributionManifest,
  options: {
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    readonly smoke?: (
      environment: ExecutionEnvironment,
      home: string,
      signal?: AbortSignal,
    ) => Promise<void>;
  } = {},
): Promise<PreparedDistribution> {
  const manifest = distributionManifestSchema.parse(input);
  const { installRoot, platform, version: oldVersion } = current.installation;
  if (current.mode !== "bundled" || !installRoot || !platform) {
    throw new Error("This is not an installed standalone Roll instance");
  }
  const rootStat = await lstat(installRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Invalid standalone installation directory");
  }
  const marker: unknown = JSON.parse(
    await readFile(join(installRoot, "installation.json"), "utf8"),
  );
  z.object({ schemaVersion: z.literal(1), channel: z.literal("standalone") }).parse(marker);
  const asset = selectDistributionAsset(manifest, platform);
  // Register before the first lock write. Cancellation first stops I/O/children, then the
  // catch path disposes resources; releasing a lock while extraction is alive is unsafe.
  const controller = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM") =>
    controller.abort(new DistributionUpdateInterruptedError(signal));
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const signal = controller.signal;
  let release: (() => Promise<void>) | undefined;
  let scratch: string | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposed = true;
    disposal ??= (async () => {
      try {
        if (scratch) await rm(scratch, { recursive: true, force: true });
      } finally {
        await release?.();
      }
    })();
    return disposal;
  };
  try {
    release = await acquireDistributionLock(installRoot);
    signal.throwIfAborted();
    await assertCurrentVersion(installRoot, oldVersion);
    scratch = await mkdtemp(join(installRoot, ".update-"));
    const archive = join(scratch, asset.filename);
    await downloadDistributionAsset(manifest, asset, archive, { ...options, signal });
    signal.throwIfAborted();
    const candidate = join(scratch, "candidate");
    await mkdir(candidate);
    await extractDistributionArchive(archive, candidate, platform, signal);
    signal.throwIfAborted();
    const environment = resolveExecutionEnvironment({ packageRoot: join(candidate, "app") });
    if (
      environment.installation.version !== manifest.version ||
      environment.installation.platform !== platform
    ) {
      throw new Error("Downloaded Roll distribution identity does not match its manifest");
    }
    const metadata: unknown = JSON.parse(
      await readFile(join(candidate, "distribution.json"), "utf8"),
    );
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("nodeVersion" in metadata) ||
      metadata.nodeVersion !== manifest.nodeVersion
    ) {
      throw new Error("Downloaded Node version does not match its manifest");
    }
    const smokeHome = join(scratch, "smoke-home");
    await mkdir(smokeHome);
    await (options.smoke ?? smokeDistribution)(environment, smokeHome, signal);
    signal.throwIfAborted();
    let activated = false;
    return {
      version: manifest.version,
      async activate() {
        if (disposed) throw new Error("Prepared distribution has been disposed");
        const target = join(installRoot, "versions", manifest.version);
        if (activated) return resolveExecutionEnvironment({ packageRoot: join(target, "app") });
        await assertCurrentVersion(installRoot, oldVersion);
        await mkdir(join(installRoot, "versions"), { recursive: true });
        const versionsStat = await lstat(join(installRoot, "versions"));
        if (!versionsStat.isDirectory() || versionsStat.isSymbolicLink()) {
          throw new Error("Invalid versions directory");
        }
        try {
          await lstat(target);
          if (
            (await distributionTreeDigest(target)) !== (await distributionTreeDigest(candidate))
          ) {
            throw new Error(
              `Refusing to overwrite different immutable Roll version ${manifest.version}`,
            );
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
          await rename(candidate, target);
        }
        const next = resolveExecutionEnvironment({ packageRoot: join(target, "app") });
        const pointer = join(installRoot, `.current-${randomUUID()}.tmp`);
        try {
          await writeFile(pointer, `${manifest.version}\n`, { flag: "wx", mode: 0o600 });
          await rename(pointer, join(installRoot, "current.txt"));
        } finally {
          await rm(pointer, { force: true });
        }
        activated = true;
        return next;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

export async function acquireDistributionLock(root: string): Promise<() => Promise<void>> {
  const lock = join(root, ".install-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Another Roll installer/update holds .install-lock; do not remove it until that process has stopped",
      );
    }
    throw error;
  }
  const ownerPath = join(lock, "owner.json");
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };
  try {
    await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rmdir(lock).catch(() => {});
    throw error;
  }
  let release: Promise<void> | undefined;
  return () => {
    release ??= (async () => {
      const actual: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
      if (
        typeof actual !== "object" ||
        actual === null ||
        !("token" in actual) ||
        actual.token !== owner.token ||
        (await readdir(lock)).some((name) => name !== "owner.json")
      ) {
        throw new Error("Roll installation lock ownership changed; refusing to remove it");
      }
      await unlink(ownerPath);
      await rmdir(lock);
    })();
    return release;
  };
}

async function assertCurrentVersion(root: string, expected: string): Promise<void> {
  const pointer = join(root, "current.txt");
  if (!(await lstat(pointer)).isFile()) throw new Error("Invalid Roll current version pointer");
  const current = (await readFile(pointer, "utf8")).trim();
  if (current !== expected) {
    throw new Error(
      "This Roll instance is not the current installed version; run update through the stable launcher",
    );
  }
}

export async function downloadDistributionAsset(
  manifest: DistributionManifest,
  asset: DistributionAsset,
  destination: string,
  options: {
    readonly timeoutMs?: number;
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  const validated = distributionManifestSchema.parse(manifest);
  const expected = selectDistributionAsset(validated, asset.platform);
  if (JSON.stringify(expected) !== JSON.stringify(asset)) {
    throw new Error("Asset does not belong to manifest");
  }
  const response = await (options.fetch ?? globalThis.fetch)(
    `${DISTRIBUTION_ORIGIN}/releases/${validated.version}/${expected.filename}`,
    {
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? 180_000),
        ...(options.signal ? [options.signal] : []),
      ]),
    },
  );
  if (!response.ok) throw new Error(`Roll distribution download HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty distribution archive");
  const file = await open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size) throw new Error("Roll distribution size mismatch");
      hash.update(value);
      await file.writeFile(value);
    }
    if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw new Error("Roll distribution checksum/size mismatch");
    }
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}

export function validateArchiveEntry(name: string): void {
  if (
    !name ||
    name.includes("\\") ||
    [...name].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === ":",
    ) ||
    name.startsWith("/") ||
    name.split("/").includes("..")
  ) {
    throw new Error("Unsafe distribution archive entry");
  }
  const normalized = posix.normalize(name).replace(/^\.\//, "");
  if (
    normalized !== "" &&
    normalized !== "." &&
    normalized !== "./" &&
    normalized !== "distribution.json" &&
    !/^(app|runtime)(\/|$)/.test(normalized)
  ) {
    throw new Error("Unexpected distribution archive entry");
  }
}

export async function extractDistributionArchive(
  archive: string,
  destination: string,
  platform: string,
  signal?: AbortSignal,
): Promise<void> {
  if (platform.startsWith("win32-")) {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:ROLL_EXTRACT_ARCHIVE)
try {
  foreach ($entry in $zip.Entries) {
    $n = $entry.FullName
    $kind = ($entry.ExternalAttributes -shr 16) -band 61440
    if (!$n -or $n -match '[\\\\:\\x00-\\x1f\\x7f]' -or $n.StartsWith('/') -or ($n.Split('/') -contains '..') -or ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384)) { throw 'Unsafe archive entry' }
    if ($n -ne 'distribution.json' -and $n -notmatch '^(app|runtime)(/|$)') { throw 'Unexpected archive entry' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($env:ROLL_EXTRACT_ARCHIVE, $env:ROLL_EXTRACT_DESTINATION)
`;
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          ROLL_EXTRACT_ARCHIVE: archive,
          ROLL_EXTRACT_DESTINATION: destination,
        },
        timeout: 180_000,
        ...(signal ? { signal } : {}),
      },
    );
  } else {
    const options = {
      timeout: 180_000,
      ...(signal ? { signal } : {}),
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    };
    const listing = await execFileAsync("tar", ["-tzf", archive], options);
    for (const name of listing.stdout.trimEnd().split("\n")) validateArchiveEntry(name);
    const verbose = await execFileAsync("tar", ["-tvzf", archive], options);
    for (const line of verbose.stdout.trimEnd().split("\n")) {
      if (!line.startsWith("-") && !line.startsWith("d")) {
        throw new Error("Distribution archive contains links or special files");
      }
    }
    await execFileAsync("tar", ["-xzf", archive, "-C", destination, "--no-same-owner"], options);
  }
  // Validate actual extracted types too, including Windows reparse/symlink entries.
  await distributionTreeDigest(destination, signal);
}

async function distributionTreeDigest(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string, rel: string): Promise<void> {
    signal?.throwIfAborted();
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Distribution contains a symbolic link");
    if (stat.isDirectory()) {
      hash.update(`d:${rel}\0`);
      for (const name of (await readdir(path)).sort()) {
        await walk(join(path, name), `${rel}/${name}`);
      }
    } else if (stat.isFile()) {
      hash.update(`f:${rel}\0${stat.size}\0`);
      const file = await open(path, "r");
      try {
        for await (const chunk of file.createReadStream(signal ? { signal } : {})) {
          hash.update(chunk);
        }
      } finally {
        await file.close();
      }
    } else throw new Error("Distribution contains a special file");
  }
  await walk(root, "");
  return hash.digest("hex");
}

export async function smokeDistribution(
  environment: ExecutionEnvironment,
  home: string,
  signal?: AbortSignal,
): Promise<void> {
  await writeFile(join(home, "roll.config.yaml"), "{}\n");
  const env = environment.createEnv({
    PATH: process.env["PATH"],
    SystemRoot: process.env["SystemRoot"],
    WINDIR: process.env["WINDIR"],
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: home,
    APPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    NODE_ENV: "production",
  });
  const entry = join(environment.installation.packageRoot, "bin/roll.js");
  const options = {
    cwd: home,
    env,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  };
  const metadata = z
    .object({ nodeVersion: z.string() })
    .parse(
      JSON.parse(
        await readFile(join(environment.installation.versionRoot!, "distribution.json"), "utf8"),
      ),
    );
  const node = await execFileAsync(environment.nodePath, ["-p", "process.versions.node"], options);
  if (node.stdout.trim() !== metadata.nodeVersion) {
    throw new Error("Private Node executable does not match distribution metadata");
  }
  const version = await execFileAsync(environment.nodePath, [entry, "--version"], options);
  if (!version.stdout.includes(environment.installation.version)) {
    throw new Error("Roll candidate reports the wrong version");
  }
  await execFileAsync(environment.nodePath, [entry, "agent", "health"], options);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
