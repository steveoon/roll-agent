import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { PUBLISHED_PACKAGES } from "./published-packages.mjs";
import { assertLicenseTextMatches, SUSPICIOUS_FILE_NAMES } from "./verify-published-packages.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

describe("published-package tarball IoCs", () => {
  it("rejects the Shai-Hulud payload filenames in packed tarballs", () => {
    assert.equal(SUSPICIOUS_FILE_NAMES.has("setup.mjs"), true);
    assert.equal(SUSPICIOUS_FILE_NAMES.has("Math_Symbol.js"), true);
    assert.equal(SUSPICIOUS_FILE_NAMES.has("math_init.js"), true);
  });
});

describe("workspace license policy", () => {
  it("declares FSL-1.1-ALv2 at the repository root", async () => {
    const rootManifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
    const rootLicense = await readFile(resolve(repoRoot, "LICENSE"), "utf8");

    assert.equal(rootManifest.license, "FSL-1.1-ALv2");
    assertLicenseTextMatches("roll-agent-monorepo", "FSL-1.1-ALv2", rootLicense);
  });

  it("matches every published package manifest license with its local LICENSE file", async () => {
    for (const pkg of PUBLISHED_PACKAGES) {
      const manifestPath = resolve(repoRoot, pkg.packageJson);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const licenseText = await readFile(resolve(dirname(manifestPath), "LICENSE"), "utf8");

      assert.equal(manifest.license, pkg.license, `${pkg.name} package.json#license mismatch`);
      assertLicenseTextMatches(pkg.name, pkg.license, licenseText);
    }
  });
});
