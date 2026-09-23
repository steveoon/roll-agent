import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { NativeCdpController } from "@roll-agent/browser";

/** Test-only owned browser; excluded from release declarations and never uses a user profile. */
export async function browserTestFixture(html: (path: string) => string) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html(request.url ?? "/"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const a = server.address();
  assert.ok(a && typeof a !== "string");
  const origin = `http://127.0.0.1:${a.port}`;
  const profile = await mkdtemp(join(tmpdir(), "roll-form-context-"));
  const chrome = spawn(
    process.env["CHROME_EXECUTABLE"] ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,1000",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let controller: NativeCdpController | undefined;
  const close = async () => {
    controller?.close();
    chrome.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
      else chrome.once("exit", () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port = "";
    for (let i = 0; i < 80; i++) {
      port =
        (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split(
          "\n",
        )[0] ?? "";
      if (port) break;
      await delay(100);
    }
    assert.ok(port);
    const targets = z
      .array(
        z.object({ id: z.string(), type: z.string(), webSocketDebuggerUrl: z.string().optional() }),
      )
      .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const tab = targets.find((t) => t.type === "page");
    assert.ok(tab?.webSocketDebuggerUrl);
    controller = await NativeCdpController.connect({
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
    });
    return { controller, pageId: tab.id, origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
