import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserScriptPageDriver, readBrowserDocumentIdentity } from "@roll-agent/browser";
import { browserTestFixture } from "./browser-test-fixture.e2e.ts";
import { observeBrowserPage } from "../browser-observation.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { permittedFrames } from "./host.ts";
import { inspectGoalControls } from "./observation.ts";
import { attachTaskText } from "./task-observation.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { runBrowserTask } from "./task-loop.ts";
import { createJevProvider } from "./decisions.ts";

const html = `<!doctype html><meta charset="utf-8"><style>body{font:20px sans-serif;padding:30px}input,button{font:inherit;margin:10px}.entry{cursor:pointer;padding:15px;display:block}dialog{width:700px}dialog::backdrop{background:#8888}</style><h2>Dimensions</h2><span id="entry" class="entry">Length: 2–6 cm</span><span id="other" class="entry">Edit address</span><input aria-label="Address" readonly value="East"><button id="save">Save</button><dialog id="panel"><h2>Edit dimensions</h2><label>Minimum length<input id="low" aria-label="Minimum length" value="2"></label><label>Maximum length<input id="high" aria-label="Maximum length" value="6"></label><button id="apply">Apply</button></dialog><script>window.saves=0;window.otherClicks=0;const entry=document.getElementById('entry'),panel=document.getElementById('panel');entry.onclick=()=>panel.showModal();document.getElementById('other').onclick=()=>window.otherClicks++;document.getElementById('apply').onclick=()=>{entry.textContent='Length: '+document.getElementById('low').value+'–'+document.getElementById('high').value+' cm';panel.close()};document.getElementById('save').onclick=()=>window.saves++;</script>`;

test(
  "Jev opens a display-only entry and completes two delegated dimensions without touching another editor",
  { skip: process.env["RUN_EDITOR_ENTRY_E2E"] !== "1", timeout: 90000 },
  async () => {
    const fixture = await browserTestFixture(() => html);
    const c = fixture.controller;
    try {
      await c.navigate(fixture.origin);
      for (let i = 0; i < 80; i++) {
        if (await c.evaluateJson('Boolean(document.getElementById("entry"))')) break;
        await delay(25);
      }
      const signal = AbortSignal.timeout(70000);
      const browserInstance = "editor-entry-regression";
      const observe = async () => {
        const tree = await c.getFrameTree();
        const raw = await observeBrowserPage({
          controller: c,
          page: { targetId: fixture.pageId },
          browserInstance,
          allowedOrigins: [fixture.origin],
          allowedFrameIds: permittedFrames(tree, [fixture.origin]),
          maxNodes: 240,
          interactiveOnly: true,
        });
        return attachTaskText(
          c,
          await inspectGoalControls(c, raw, [fixture.origin], signal),
          [fixture.origin],
          signal,
        );
      };
      const driver = new BrowserScriptPageDriver({
        controller: c,
        pageId: fixture.pageId,
        browserInstance,
        allowedOrigins: [fixture.origin],
        capabilities: ["read", "interact"],
        signal,
        guard: async () => {},
        observe,
        resolveRef: async (ref, snapshotId) =>
          browserElementRefStore.getScopedRef({
            ref,
            snapshotId,
            browserInstance,
            pageId: fixture.pageId,
            documentId: await readBrowserDocumentIdentity(c),
          }),
        capture: async () => {
          throw Error("No capture");
        },
      });
      const input = BrowserOperateInputSchema.parse({
        pageId: fixture.pageId,
        engine: "jev",
        strategy: "task",
        model: "jev-1.13.0",
        goal: "Set the minimum length to 4 cm and maximum length to 9 cm through the dimensions editor. Apply to the main form and close the editor. Preserve Address. Do not Save or open the address editor.",
        values: [
          { name: "low", text: "4" },
          { name: "high", text: "9" },
        ],
        formTask: {
          mode: "edit",
          fields: [
            { name: "Minimum length", intent: "set", valueName: "low" },
            { name: "Maximum length", intent: "set", valueName: "high" },
            { name: "Address", intent: "preserve" },
          ],
        },
        allowedOrigins: [fixture.origin],
        blockedNames: ["Save"],
        maxSteps: 25,
      });
      const result = await runBrowserTask(
        input,
        {
          observe,
          checkTarget: async () => true,
          invoke: async (m, p) => driver.invoke(m, p),
          actionExecuted: () => driver.lastActionExecuted,
        },
        createJevProvider({ apiKey: process.env["TYPESAFE_API_KEY"]!, model: "jev-1.13.0" }),
        signal,
      );
      assert.equal(
        result.status,
        "interaction_done",
        JSON.stringify({
          error: result.error,
          steps: result.steps.map((s) => ({ op: s.operation, target: s.target })),
          form: result.execution?.form,
        }),
      );
      assert.ok(result.steps.some((s) => s.operation === "CLICK" && s.target?.includes("Length:")));
      assert.deepEqual(
        await c.evaluateJson(
          "({low:document.getElementById('low').value,high:document.getElementById('high').value,summary:document.getElementById('entry').textContent,open:document.getElementById('panel').open,saves:window.saves,other:window.otherClicks})",
        ),
        { low: "4", high: "9", summary: "Length: 4–9 cm", open: false, saves: 0, other: 0 },
      );
    } finally {
      await fixture.close();
    }
  },
);
