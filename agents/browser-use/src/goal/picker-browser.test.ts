import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  NativeCdpController,
  BrowserScriptPageDriver,
  readBrowserDocumentIdentity,
} from "@roll-agent/browser";
import { observeBrowserPage } from "../browser-observation.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { inspectGoalControls, INSPECT_GOAL_CONTROL, GoalControlSchema } from "./observation.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { createJevProvider } from "./decisions.ts";
import { runBrowserTask } from "./task-loop.ts";
import { permittedFrames } from "./host.ts";

function fixture(labels: string[], value: string) {
  return `<!doctype html><html><meta charset="utf-8"><style>body{font:18px sans-serif;margin:40px}.pair{display:flex;gap:20px}.widget{width:190px}.trigger{border:1px solid #888;padding:12px;cursor:pointer}ul{padding:0;margin:0;border:1px solid #aaa;list-style:none}li{padding:12px;cursor:pointer}li:hover{background:#ddd}</style>
  <h2>${labels.join(" / ")}</h2><form><div class="pair">${labels.map((label, i) => `<section class="widget"><div id="trigger${i}" class="trigger" tabindex="0"><input type="hidden"><span>${label}</span></div><ul id="menu${i}" style="display:none"><li>${value}</li><li>${i === 0 ? "Alternative A" : "Alternative B"}</li></ul></section>`).join("")}</div><button type="submit">Publish</button></form>
  <script>window.counts={selections:[0,0],submits:0};document.querySelector('form').onsubmit=e=>{e.preventDefault();counts.submits++};document.querySelectorAll('.widget').forEach((w,i)=>{const trigger=w.querySelector('.trigger'),menu=w.querySelector('ul');trigger.onclick=()=>{const open=menu.style.display!=='none';document.querySelectorAll('.widget ul').forEach(p=>p.style.display='none');menu.style.display=open?'none':'block'};menu.querySelectorAll('li').forEach((li,j)=>li.onclick=()=>{trigger.querySelector('input').value=String(j+1);trigger.querySelector('span').textContent=li.textContent;menu.style.display='none';counts.selections[i]++})});</script></html>`;
}

test(
  "generic picker DOM evidence and same-label choices work without host assistance",
  {
    skip: process.env["RUN_PICKER_BROWSER_TESTS"] !== "1",
    timeout: 120000,
  },
  async (t) => {
    let html = fixture(["Choose delivery", "Choose payment"], "Default");
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "jev-picker-"));
    const chrome = spawn(
      process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=1200,900",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve) => {
      chrome.once("exit", () => resolve());
      chrome.once("error", () => resolve());
    });
    let controller: NativeCdpController | undefined;
    let driver: BrowserScriptPageDriver | undefined;
    let pageId: string | undefined;
    try {
      let port = "";
      for (let i = 0; i < 100 && !port; i++) {
        try {
          port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
        } catch {
          await delay(50);
        }
      }
      assert.ok(port);
      const tabs = z
        .array(
          z.object({
            id: z.string(),
            type: z.string(),
            webSocketDebuggerUrl: z.string().optional(),
          }),
        )
        .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      const tab = tabs.find((tab) => tab.type === "page");
      assert.ok(tab?.webSocketDebuggerUrl);
      pageId = tab.id;
      const c = (controller = await NativeCdpController.connect({
        webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
      }));
      const navigate = async (label = "Choose delivery") => {
        await c.navigate(origin);
        for (let i = 0; i < 80; i++) {
          if (
            await c.evaluateJson(
              `document.readyState === 'complete' && document.querySelector('#trigger0 span')?.textContent === ${JSON.stringify(label)}`,
            )
          ) {
            return;
          }
          await delay(25);
        }
        assert.fail("fixture not ready");
      };
      await navigate();
      const inspect = async (id: string) =>
        GoalControlSchema.parse(
          await c.evaluateJson(
            `(${INSPECT_GOAL_CONTROL}).call(document.getElementById(${JSON.stringify(id)}),${JSON.stringify([origin])})`,
          ),
        );
      const first = await inspect("trigger0");
      assert.equal(first.picker?.label, "Choose delivery");
      assert.equal(first.picker?.selection, "empty");
      assert.equal(first.picker?.expanded, false);
      assert.equal(first.picker?.relationship, "local-dom");
      await c.evaluateJson(
        "document.getElementById('trigger0').click(); document.querySelector('#menu0 li').id='option0'; true",
      );
      const option = await inspect("option0");
      assert.equal(option.picker?.part, "option");
      assert.equal(option.picker?.triggerPath, first.picker?.triggerPath);
      assert.equal(option.picker?.label, "Choose delivery");
      assert.equal(option.picker?.expanded, true);
      assert.equal(
        JSON.stringify(option).includes('"value":"1"'),
        false,
        "Do not expose hidden backing values",
      );
      await c.evaluateJson("document.getElementById('option0').click(); true");
      const selected = await inspect("trigger0");
      assert.equal(selected.picker?.committedText, "Default");
      assert.equal(selected.picker?.expanded, false);
      assert.equal(selected.picker?.label, undefined, "Display value is not a stable field label");
      // Portals use explicit ARIA links; two controllers make ownership unknown.
      await c.evaluateJson(
        `document.body.insertAdjacentHTML('beforeend','<button id="portal-trigger" aria-label="Portal choice" aria-controls="portal-list" aria-haspopup="listbox">Choose</button><div id="portal-list" role="listbox"><div id="portal-option" role="option" aria-selected="false">Default</div></div><article><ul><li id="article-item">Article item</li></ul></article>'); true`,
      );
      assert.equal((await inspect("portal-option")).picker?.relationship, "aria");
      assert.equal((await inspect("portal-option")).picker?.optionSelected, false);
      await c.evaluateJson(
        `document.body.insertAdjacentHTML('beforeend','<button aria-controls="portal-list" aria-haspopup="listbox">Second controller</button>'); true`,
      );
      assert.equal((await inspect("portal-option")).picker?.relationship, "unknown");
      assert.equal((await inspect("portal-option")).picker?.triggerPath, undefined);
      assert.equal((await inspect("article-item")).picker, undefined);
      await c.evaluateJson("document.querySelector('#trigger0 input').value=''; true");
      assert.equal(
        (await inspect("trigger0")).picker?.selection,
        "unknown",
        "An explicitly empty backing value can be a legitimate selection, not necessarily a placeholder",
      );
      await c.evaluateJson(
        `document.body.insertAdjacentHTML('beforeend','<label>Native default<select id="native-empty"><option value="">All</option></select></label>'); true`,
      );
      assert.equal((await inspect("native-empty")).picker?.committedText, "All");
      assert.equal((await inspect("native-empty")).picker?.selection, "value");
      await c.evaluateJson(
        `document.body.insertAdjacentHTML('beforeend','<div id="nested-trigger" tabindex="0"><input type="hidden" value="1"><span>Default</span><ul><li>Default</li><li>Different choice</li></ul></div>'); true`,
      );
      const nested = (await inspect("nested-trigger")).picker;
      assert.equal(nested?.relationship, "local-dom");
      assert.equal(
        nested?.committedText,
        "Default",
        "Nested menu labels must not enter the trigger value",
      );
      await c.evaluateJson(
        `document.body.insertAdjacentHTML('beforeend','<input id="pending-query" role="combobox" aria-label="City" aria-controls="pending-list" aria-expanded="true" value="Shanghai"><ul id="pending-list" role="listbox" hidden><li role="option">Shanghai</li></ul>'); true`,
      );
      const pending = (await inspect("pending-query")).picker;
      assert.equal(pending?.expanded, true);
      assert.equal(pending?.panelVisible, false);
      assert.equal(pending?.selection, "unknown");
      assert.equal(pending?.queryText, "Shanghai");
      for (const [labels, desired] of [
        [["Choose delivery", "Choose payment"], "Default"],
        [["选择经验", "选择学历"], "不限"],
      ] as const) {
        html = fixture([...labels], desired);
        await navigate(labels[0]);
        const signal = AbortSignal.timeout(45000);
        const browserInstance = "picker-fixture";
        const observe = async () => {
          const tree = await c.getFrameTree();
          const snapshot = await observeBrowserPage({
            controller: c,
            page: { targetId: tab.id },
            browserInstance,
            allowedOrigins: [origin],
            allowedFrameIds: permittedFrames(tree, [origin]),
            maxNodes: 200,
            interactiveOnly: true,
          });
          return inspectGoalControls(c, snapshot, [origin], signal);
        };
        driver = new BrowserScriptPageDriver({
          controller: c,
          pageId: tab.id,
          browserInstance,
          allowedOrigins: [origin],
          capabilities: ["read", "interact"],
          signal,
          guard: async () => signal.throwIfAborted(),
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
            throw new Error("No screenshot needed");
          },
        });
        const native = driver;
        const live =
          process.env["RUN_PICKER_LIVE_JEV"] === "1"
            ? createJevProvider({
                apiKey: process.env["TYPESAFE_API_KEY"] ?? "",
                model: "jev-1.13.0",
              })
            : undefined;
        const input = BrowserOperateInputSchema.parse({
          pageId: tab.id,
          goal: `Set BOTH ${labels[0]} and ${labels[1]} to ${desired}. Both selections must be applied. Do not publish.`,
          values: labels.map((name) => ({ name, text: desired })),
          allowedOrigins: [origin],
          blockedNames: ["Publish"],
          maxSteps: 15,
        });
        const result = await runBrowserTask(
          input,
          {
            observe,
            invoke: (method, args) => native.invoke(method, args),
            actionExecuted: () => native.lastActionExecuted,
          },
          live ??
            (async (request) => {
              const state = z
                .object({
                  pickerFields: z.array(
                    z.object({
                      id: z.string(),
                      triggerRef: z.string().optional(),
                      selection: z.string(),
                      expanded: z.boolean().optional(),
                      optionRefs: z.array(z.string()),
                    }),
                  ),
                })
                .parse(request.state);
              const field = state.pickerFields.find((field) => field.selection === "empty");
              const action = field
                ? `CLICK:${field.expanded ? field.optionRefs[0] : field.triggerRef}`
                : "DONE";
              assert.ok(request.questions.operation!.criteria[action]);
              return {
                choices: {
                  operation: action,
                  ...(action === "DONE" ? { completion: "COMPLETE" } : {}),
                },
                provider: "fixture",
                requestedModel: "fixture",
                resolvedModel: "fixture",
                elapsedMs: 0,
              };
            }),
          signal,
        );
        const oracle = await c.evaluateJson(
          "({values:[...document.querySelectorAll('.trigger input')].map(e=>e.value),text:[...document.querySelectorAll('.trigger span')].map(e=>e.textContent),open:[...document.querySelectorAll('.widget ul')].some(e=>e.style.display!=='none'),counts})",
        );
        assert.deepEqual(
          oracle,
          {
            values: ["1", "1"],
            text: [desired, desired],
            open: false,
            counts: { selections: [1, 1], submits: 0 },
          },
          JSON.stringify({ result, oracle }),
        );
        assert.equal(result.status, "model_done");
        assert.equal(result.verified, false);
        assert.deepEqual(result.textCalls, []);
        t.diagnostic(
          JSON.stringify({
            labels,
            live: !!live,
            elapsedMs: result.elapsedMs,
            steps: result.steps.map((s) => ({ operation: s.operation, target: s.target })),
            oracle,
          }),
        );
        driver.close();
        driver = undefined;
      }
    } finally {
      driver?.close();
      controller?.close();
      if (pageId) browserElementRefStore.clear(pageId);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill("SIGKILL");
        await exited;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
