import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  BrowserScriptPageDriver,
  NativeCdpController,
  readBrowserDocumentIdentity,
} from "@roll-agent/browser";
import { observeBrowserPage } from "../browser-observation.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { permittedFrames } from "./host.ts";
import { inspectGoalControls } from "./observation.ts";
import { attachTaskText } from "./task-observation.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { runBrowserTask } from "./task-loop.ts";
import { createJevProvider } from "./decisions.ts";
import type { DecisionProvider } from "./decisions.ts";

const html = (
  native: boolean,
) => `<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}button{padding:12px;margin:12px}.popup{position:fixed;inset:40px;background:white;border:2px solid black;z-index:20;padding:30px}[hidden]{display:none!important}</style>
<h1>Records list</h1><div role="tab" id="all" aria-selected="${native ? "false" : "true"}">All</div><button id="pending" role="tab" aria-selected="${native ? "true" : "false"}">Pending</button><button id="view">Preview Record A</button>
${native ? '<dialog id="detail" aria-label="Record A detail">' : '<div id="detail" class="popup" hidden>'}<h2>Record A detail</h2><div id="facts"></div><button id="close">Close</button>${native ? "</dialog>" : "</div>"}
<script>const view=document.getElementById('view'),detail=document.getElementById('detail'),facts=document.getElementById('facts');window.fixtureState={opens:0,closes:0};document.getElementById('pending').onclick=()=>{document.getElementById('all').setAttribute('aria-selected','false');document.getElementById('pending').setAttribute('aria-selected','true')};view.onclick=()=>{window.fixtureState.opens++;facts.innerHTML='<dl><dt>Pay</dt><dd>5–6K</dd><dt>Location</dt><dd>East Road 12</dd></dl>';${native ? "detail.showModal()" : "detail.hidden=false"}};document.getElementById('close').onclick=()=>{window.fixtureState.closes++;${native ? "detail.close()" : "detail.hidden=true"};facts.replaceChildren()};</script>`;

test(
  "phase memory reads and returns through native and custom DOM dialogs without reopening",
  { skip: process.env["RUN_PHASE_MEMORY_E2E"] !== "1", timeout: 120000 },
  async (t) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html(request.url === "/native"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "roll-phase-memory-"));
    const chrome = spawn(
      process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let controller: NativeCdpController | undefined;
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
          z.object({
            id: z.string(),
            type: z.string(),
            webSocketDebuggerUrl: z.string().optional(),
          }),
        )
        .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      const tab = targets.find((t) => t.type === "page");
      assert.ok(tab?.webSocketDebuggerUrl);
      controller = await NativeCdpController.connect({
        webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
      });
      const c = controller;
      for (const layout of ["native", "custom"]) {
        await t.test(layout, async () => {
          await c.navigate(`${origin}/${layout}`);
          for (let i = 0; i < 80; i++) {
            if (await c.evaluateJson('Boolean(document.getElementById("view"))')) break;
            await delay(25);
          }
          const browserInstance = `phase-${layout}`;
          const signal = AbortSignal.timeout(45000);
          const observe = async () => {
            const tree = await c.getFrameTree();
            const snapshot = await observeBrowserPage({
              controller: c,
              page: { targetId: tab.id },
              browserInstance,
              allowedOrigins: [origin],
              allowedFrameIds: permittedFrames(tree, [origin]),
              maxNodes: 240,
              interactiveOnly: true,
            });
            return attachTaskText(
              c,
              await inspectGoalControls(c, snapshot, [origin], signal),
              [origin],
              signal,
              true,
            );
          };
          const driver = new BrowserScriptPageDriver({
            controller: c,
            pageId: tab.id,
            browserInstance,
            allowedOrigins: [origin],
            capabilities: ["read", "interact"],
            signal,
            guard: async () => {},
            observe,
            resolveRef: async (ref, snapshotId) =>
              browserElementRefStore.getScopedRef({
                ref,
                snapshotId,
                browserInstance,
                pageId: tab.id,
                documentId: await readBrowserDocumentIdentity(c),
              }),
            capture: async () => {
              throw Error("No screenshots in this test");
            },
          });
          let count = 0;
          const stub: DecisionProvider = async (request) => {
            count++;
            const state = z.record(z.unknown()).parse(request.state);
            const progress = z.object({ phase: z.string() }).parse(state.taskProgress);
            const label = progress.phase === "collect" ? "Preview Record A" : "Close";
            let action = Object.entries(request.questions.operation!.criteria).find(
              ([key, value]) => key.startsWith("CLICK:") && value.includes(label),
            )?.[0];
            if (!action && !request.questions.operation!.criteria.DONE) {
              action = Object.entries(request.questions.operation!.criteria).find(
                ([key, value]) => key.startsWith("CLICK:") && value.includes("Pending"),
              )?.[0];
            }
            const answers: Record<string, string> = { operation: action ?? "DONE" };
            if (!action) answers.completion = "COMPLETE";
            if (request.questions.capture_region) {
              answers.capture_region =
                Object.keys(request.questions.capture_region.criteria).find((key) =>
                  key.startsWith("r"),
                ) ?? "NONE";
              for (const key of request.evidenceRouting?.capture_region?.[answers.capture_region] ??
                []) {
                answers[key] =
                  Object.entries(request.questions[key]!.criteria).find(
                    ([, label]) => label === (key.endsWith("_0") ? "5–6K" : "East Road 12"),
                  )?.[0] ?? "NONE";
              }
            }
            if (request.questions.progress_terminal) {
              answers.progress_terminal = action ? "NOT_READY" : "READY";
            }
            return {
              choices: answers,
              elapsedMs: 0,
              provider: "fixture",
              requestedModel: "fixture",
              resolvedModel: "fixture",
            };
          };
          const decide =
            process.env["RUN_PHASE_MEMORY_LIVE_JEV"] === "1"
              ? createJevProvider({
                  apiKey: process.env["TYPESAFE_API_KEY"] ?? "",
                  model: "jev-1.13.0",
                })
              : stub;
          try {
            const input = BrowserOperateInputSchema.parse({
              pageId: tab.id,
              engine: "jev",
              model: "jev-1.13.0",
              allowedOrigins: [origin],
              goal: "Open Record A preview, read Pay and Location, then close and return to Pending Records list. Report the captured facts.",
              readTask: {
                target: "Record A",
                captureView: "Record A detail panel",
                outputs: ["Pay", "Location"],
                terminal: { view: "Records list", selectedTab: "Pending" },
              },
              maxSteps: 20,
            });
            const result = await runBrowserTask(
              input,
              {
                observe,
                invoke: (method, args) => driver.invoke(method, args),
                actionExecuted: () => driver.lastActionExecuted,
              },
              decide,
              signal,
            );
            assert.equal(
              result.status,
              "interaction_done",
              JSON.stringify({
                status: result.status,
                error: result.error,
                steps: result.steps.map((s) => [s.operation, s.error]),
                progress: result.progress,
              }),
            );
            assert.deepEqual(
              result.progress?.evidence.map((e) => e.text),
              ["5–6K", "East Road 12"],
            );
            assert.deepEqual(await c.evaluateJson("window.fixtureState"), { opens: 1, closes: 1 });
            assert.equal(await c.evaluateJson('document.getElementById("facts").innerText'), "");
            assert.deepEqual(result.textCalls, []);
            assert.ok(count === 0 || count <= 6);
          } finally {
            driver.close();
            browserElementRefStore.clear(tab.id);
          }
        });
      }
    } finally {
      controller?.close();
      chrome.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
        else chrome.once("exit", () => resolve());
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
);
