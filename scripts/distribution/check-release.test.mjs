import assert from "node:assert/strict";
import test from "node:test";
import { needsDistributionBuild } from "./check-release.mjs";
import { assetFilename, PLATFORMS } from "./metadata.mjs";

test("docs-only or Agent-only main pushes never request a distribution or rebuild Core", async () => {
  assert.equal(
    await needsDistributionBuild("1.2.3", "1.2.3", () => {
      throw Error("must not request");
    }),
    false,
  );
});
test("new Core release builds when absent; workflow retry skips the completed immutable release", async () => {
  assert.equal(
    await needsDistributionBuild("1.2.4", "1.2.3", async (url, options) => {
      assert.equal(url, "https://roll.duliday.com/releases/1.2.4/manifest.json");
      assert.equal(options.redirect, "error");
      return new Response("missing", { status: 404 });
    }),
    true,
  );
  const manifest = {
    schemaVersion: 1,
    version: "1.2.4",
    assets: PLATFORMS.map((platform) => ({
      platform,
      filename: assetFilename("1.2.4", platform),
      sha256: "a".repeat(64),
      size: 1,
    })),
  };
  assert.equal(
    await needsDistributionBuild(
      "1.2.4",
      "1.2.3",
      async () => new Response(JSON.stringify(manifest)),
    ),
    false,
  );
  await assert.rejects(
    needsDistributionBuild(
      "1.2.4",
      "1.2.3",
      async () => new Response(JSON.stringify({ ...manifest, assets: manifest.assets.slice(1) })),
    ),
    /incomplete/,
  );
  await assert.rejects(
    needsDistributionBuild("1.2.4", "1.2.3", async () => new Response("down", { status: 503 })),
    /publication status/,
  );
});
