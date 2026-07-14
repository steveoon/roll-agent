import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  getExternalOpenCommand,
  resolveRollUiAssetsDirectory,
  resolveRollUiConfigPath,
} from "./ui.ts";

describe("roll ui command helpers", () => {
  it("uses the config discovery fallback and resolves explicit paths", () => {
    assert.equal(resolveRollUiConfigPath("fixtures/custom.yaml"), resolve("fixtures/custom.yaml"));
    assert.ok(resolveRollUiConfigPath().endsWith("roll.config.yaml"));
    assert.ok(
      resolveRollUiConfigPath().startsWith(resolve(homedir())) ||
        resolveRollUiConfigPath().startsWith(process.cwd()),
    );
  });

  it("locates UI assets beside source and built command modules", () => {
    assert.equal(
      resolveRollUiAssetsDirectory("file:///workspace/packages/core/src/cli/commands/ui.ts"),
      "/workspace/packages/core/dist/ui-assets",
    );
    assert.equal(
      resolveRollUiAssetsDirectory("file:///workspace/packages/core/dist/cli/commands/ui.js"),
      "/workspace/packages/core/dist/ui-assets",
    );
  });

  it("uses shell-free platform launch commands", () => {
    const url = "http://127.0.0.1:3210/#token=one-time";
    assert.deepEqual(getExternalOpenCommand(url, "darwin"), { command: "open", args: [url] });
    assert.deepEqual(getExternalOpenCommand(url, "linux"), {
      command: "xdg-open",
      args: [url],
    });
    assert.deepEqual(getExternalOpenCommand(url, "win32"), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", url],
    });
  });
});
