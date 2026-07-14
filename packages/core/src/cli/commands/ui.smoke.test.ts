import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runRollUi } from "./ui.ts";

/**
 * HTTP-level smoke for the `roll ui` launch path:
 * runRollUi → loopback server → bootstrap session → GET /api/config.
 * Uses a temp assets dir so unit CI does not require a prior vite ui-assets build.
 */
describe("roll ui smoke", () => {
  it("bootstraps a session and reads config over the loopback server", async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-ui-smoke-"));
    const assetsDirectory = join(root, "ui-assets");
    const dataDir = join(root, "agents");
    const configPath = join(root, "roll.config.yaml");
    mkdirSync(assetsDirectory, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(assetsDirectory, "index.html"),
      "<!doctype html><title>Roll UI Smoke</title>",
    );
    writeFileSync(
      configPath,
      `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
ask: {}
agents:
  data-dir: ${dataDir}
`,
    );

    let launchUrl: string | undefined;

    try {
      await runRollUi(
        { configPath, open: true },
        {
          assetsDirectory,
          openExternalUrl: async (url) => {
            launchUrl = url;
          },
          waitForShutdown: async () => {
            assert.ok(launchUrl !== undefined, "expected launch URL from openExternalUrl");
            const launch = new URL(launchUrl);
            const token = new URLSearchParams(launch.hash.slice(1)).get("token");
            assert.ok(token !== null && token.length > 0);

            const origin = `${launch.protocol}//${launch.host}`;
            const basePath = launch.pathname.replace(/\/$/u, "");

            const index = await fetch(`${origin}${basePath}/`);
            assert.equal(index.status, 200);
            assert.match(await index.text(), /Roll UI Smoke/u);

            const bootstrap = await fetch(`${origin}${basePath}/api/bootstrap`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin,
              },
              body: JSON.stringify({ token }),
            });
            assert.equal(bootstrap.status, 200);
            const setCookie = bootstrap.headers.get("set-cookie");
            assert.ok(setCookie !== null);
            const cookie = setCookie.split(";", 1)[0];
            assert.ok(cookie !== undefined && cookie.length > 0);

            const bootstrapPayload: unknown = await bootstrap.json();
            assert.ok(isRecord(bootstrapPayload));
            assert.ok(isRecord(bootstrapPayload.data));
            assert.equal(typeof bootstrapPayload.data.csrfToken, "string");

            const config = await fetch(`${origin}${basePath}/api/config`, {
              headers: { cookie },
            });
            assert.equal(config.status, 200);
            const configPayload: unknown = await config.json();
            assert.ok(isRecord(configPayload));
            assert.ok(isRecord(configPayload.data));
            assert.ok(isRecord(configPayload.data.persisted));
            assert.equal(typeof configPayload.data.revision, "string");

            const unauthenticated = await fetch(`${origin}${basePath}/api/config`);
            assert.equal(unauthenticated.status, 401);

            return "SIGTERM";
          },
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
