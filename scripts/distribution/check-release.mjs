import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertVersion, assetFilename, PLATFORMS } from "./metadata.mjs";

const ORIGIN = "https://roll.duliday.com";

export async function needsDistributionBuild(current, previous, request = globalThis.fetch) {
  assertVersion(current);
  if (current === previous) return false;
  const response = await request(`${ORIGIN}/releases/${current}/manifest.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return true;
  if (!response.ok) {
    throw new Error(`Cannot determine distribution publication status: HTTP ${response.status}`);
  }
  const raw = await response.text();
  if (raw.length > 64 * 1024) throw new Error("Oversized distribution manifest");
  const manifest = JSON.parse(raw);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== current ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== PLATFORMS.length ||
    !PLATFORMS.every(
      (platform) =>
        manifest.assets.filter(
          (asset) =>
            asset.platform === platform &&
            asset.filename === assetFilename(current, platform) &&
            /^[a-f0-9]{64}$/.test(asset.sha256) &&
            Number.isSafeInteger(asset.size) &&
            asset.size > 0,
        ).length === 1,
    )
  ) {
    throw new Error(
      "Existing distribution manifest is incomplete or invalid; refusing to rebuild an immutable version",
    );
  }
  return false;
}

async function main() {
  const root = resolve(import.meta.dirname, "../..");
  const current = JSON.parse(
    await readFile(resolve(root, "packages/core/package.json"), "utf8"),
  ).version;
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  const previous =
    parents.length > 1
      ? JSON.parse(
          execFileSync("git", ["show", "HEAD^:packages/core/package.json"], {
            cwd: root,
            encoding: "utf8",
          }),
        ).version
      : undefined;
  const build = await needsDistributionBuild(current, previous);
  console.log(
    build
      ? `Build standalone Roll ${current}`
      : `Skip unchanged or already published standalone Roll ${current}`,
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(process.env.GITHUB_OUTPUT, `build=${build}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
