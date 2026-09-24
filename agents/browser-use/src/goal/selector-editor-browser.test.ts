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

const html = `<!doctype html><meta charset="utf-8"><style>body{font:20px sans-serif;padding:30px}input,button{font:inherit;margin:10px}dialog{width:700px}dialog::backdrop{background:#8888}</style><label>职位类型<input id="type" aria-label="职位类型" readonly value=""></label><button id="save">发布</button><dialog id="panel"><h2>请选择职类</h2><input id="search" placeholder="请输入职位名称"><div id="choices"><button>后端开发</button><button>前端/移动开发</button></div></dialog><script>window.saves=0;const field=document.getElementById('type'),panel=document.getElementById('panel'),search=document.getElementById('search'),choices=document.getElementById('choices');field.onclick=()=>panel.showModal();search.oninput=()=>{choices.innerHTML='<button id="result">运营助理/专员</button>';document.getElementById('result').onclick=()=>{field.value='运营助理/专员';panel.close()}};document.getElementById('save').onclick=()=>window.saves++;</script>`;

test(
  "Jev recognizes a category selector with a different default category and uses its search input",
  { skip: process.env["RUN_SELECTOR_E2E"] !== "1", timeout: 90000 },
  async () => {
    const fixture = await browserTestFixture(() => html);
    const c = fixture.controller;
    try {
      await c.navigate(fixture.origin);
      for (let i = 0; i < 80; i++) {
        if (await c.evaluateJson('Boolean(document.getElementById("type"))')) break;
        await delay(25);
      }
      const signal = AbortSignal.timeout(70000);
      const browserInstance = "selector-regression";
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
        goal: "在当前岗位表单中，把职位类型选择为运营助理/专员，使用弹窗顶部输入框搜索，再选择搜索结果，应用到主表单。不发布。",
        values: [{ name: "type", text: "运营助理/专员" }],
        formTask: {
          mode: "create",
          fields: [{ name: "职位类型", intent: "set", valueName: "type" }],
        },
        allowedOrigins: [fixture.origin],
        blockedNames: ["发布"],
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
      assert.ok(
        result.steps.some(
          (s) => s.operation === "TYPE_TEXT" && s.target?.includes("请输入职位名称"),
        ),
      );
      assert.deepEqual(
        await c.evaluateJson(
          "({value:document.getElementById('type').value,open:document.getElementById('panel').open,saves:window.saves})",
        ),
        { value: "运营助理/专员", open: false, saves: 0 },
      );
    } finally {
      await fixture.close();
    }
  },
);
