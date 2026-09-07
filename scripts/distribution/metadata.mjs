import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NODE_VERSION = "24.18.0";
export const PLATFORMS = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
];

export function assertVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Distribution requires a stable numeric semantic version");
  }
  return version;
}

export function assetFilename(version, platform) {
  assertVersion(version);
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  return `roll-${version}-${platform}.${platform.startsWith("win32-") ? "zip" : "tar.gz"}`;
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createManifest(directory, version) {
  assertVersion(version);
  const assets = [];
  for (const platform of PLATFORMS) {
    const filename = assetFilename(version, platform);
    const path = resolve(directory, filename);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty asset: ${filename}`);
    assets.push({ platform, filename, sha256: await sha256(path), size: info.size });
  }
  return { schemaVersion: 1, version, nodeVersion: NODE_VERSION, assets };
}

export async function writeManifest(directory, version) {
  const manifest = await createManifest(directory, version);
  const path = resolve(directory, "manifest.json");
  // Never silently replace different release metadata on retry.
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    if ((await readFile(path, "utf8")) !== content) throw new Error("Immutable manifest differs");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(path, content, { flag: "wx" });
  }
  for (const asset of manifest.assets) {
    const row = `${version}\t${asset.sha256}\t${asset.size}\t${asset.filename}\n`;
    const rowPath = resolve(directory, `${asset.platform}.txt`);
    try {
      if ((await readFile(rowPath, "utf8")) !== row) {
        throw new Error("Immutable platform index differs");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(rowPath, row, { flag: "wx" });
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    throw new Error("Usage: node metadata.mjs <asset-directory> <version>");
  }
  await writeManifest(process.argv[2], process.argv[3]);
}
