import assert from "node:assert/strict";
import test from "node:test";
import { needsDistributionBuild } from "./check-release.mjs";
import { assetFilename, PLATFORMS } from "./metadata.mjs";

const version = "1.2.3";
const manifest = {
  schemaVersion: 1,
  version,
  assets: PLATFORMS.map((platform) => ({
    platform,
    filename: assetFilename(version, platform),
    sha256: "a".repeat(64),
    size: 1,
  })),
};

test("same-version recovery builds a missing standalone release", async () => {
  assert.equal(
    await needsDistributionBuild(version, async (url, options) => {
      assert.equal(url, "https://roll.duliday.com/releases/1.2.3/manifest.json");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response("missing", { status: 404 });
    }),
    true,
  );
});

test("same-version main pushes and workflow retries skip complete immutable releases", async () => {
  assert.equal(await needsDistributionBuild(version, async () => Response.json(manifest)), false);
});

test("invalid or partial existing manifests fail closed without rebuilding", async () => {
  for (const invalid of [
    null,
    {},
    { ...manifest, version: "1.2.2" },
    { ...manifest, assets: manifest.assets.slice(1) },
    { ...manifest, assets: [null, ...manifest.assets.slice(1)] },
    { ...manifest, assets: [manifest.assets[1], ...manifest.assets.slice(1)] },
    { ...manifest, assets: manifest.assets.map((asset) => ({ ...asset, size: 0 })) },
    { ...manifest, assets: manifest.assets.map((asset) => ({ ...asset, sha256: "invalid" })) },
    {
      ...manifest,
      assets: manifest.assets.map((asset) => ({ ...asset, filename: "other.tar.gz" })),
    },
  ]) {
    await assert.rejects(
      needsDistributionBuild(version, async () => Response.json(invalid)),
      /incomplete or invalid/,
    );
  }
  await assert.rejects(
    needsDistributionBuild(version, async () => new Response("{")),
    SyntaxError,
  );
  await assert.rejects(
    needsDistributionBuild(version, async () => new Response("x".repeat(65_537))),
    /Oversized/,
  );
});

test("HTTP failures, redirects and timeouts never mean missing release", async () => {
  for (const status of [301, 403, 429, 500, 503]) {
    await assert.rejects(
      needsDistributionBuild(version, async () => new Response("unavailable", { status })),
      /publication status/,
    );
  }
  const timeout = new DOMException("request timed out", "TimeoutError");
  await assert.rejects(
    needsDistributionBuild(version, async () => {
      throw timeout;
    }),
    (error) => error === timeout,
  );
});
