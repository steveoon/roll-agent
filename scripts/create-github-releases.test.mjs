import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReleaseTag,
  extractChangelogEntry,
  parseGitHubRepository,
} from "./create-github-releases.mjs";

describe("create-github-releases helpers", () => {
  it("builds monorepo package release tags", () => {
    assert.equal(buildReleaseTag("@roll-agent/core", "0.9.0"), "@roll-agent/core@0.9.0");
  });

  it("extracts only the requested changelog version body", () => {
    const changelog = `# @roll-agent/core

## 0.9.0

### Minor Changes

- Add instance runtime controls.

## 0.8.0

### Minor Changes

- Add clear-data command.
`;

    assert.equal(
      extractChangelogEntry(changelog, "0.9.0"),
      "### Minor Changes\n\n- Add instance runtime controls.",
    );
  });

  it("returns undefined when the changelog version is missing", () => {
    assert.equal(extractChangelogEntry("# pkg\n\n## 1.0.0\n\n- A", "2.0.0"), undefined);
  });

  it("validates GitHub repository identifiers", () => {
    assert.equal(parseGitHubRepository("steveoon/roll-agent"), "steveoon/roll-agent");
    assert.throws(() => parseGitHubRepository("steveoon"), /owner\/repo/);
  });
});
