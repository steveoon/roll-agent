import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { BrowserScriptPageDriver, readBrowserDocumentIdentity } from "@roll-agent/browser";
import { browserTestFixture } from "./browser-test-fixture.e2e.ts";
import { observeBrowserPage } from "../browser-observation.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { permittedFrames } from "./host.ts";
import { inspectGoalControls, INSPECT_GOAL_CONTROL, GoalControlSchema } from "./observation.ts";
import { attachTaskText } from "./task-observation.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import { runBrowserTask } from "./task-loop.ts";
import { createJevProvider } from "./decisions.ts";
import type { DecisionProvider } from "./decisions.ts";

const form = `<!doctype html><meta charset="utf-8"><style>body{padding:30px;font:18px sans-serif}#picker{padding:12px;width:180px;cursor:pointer;border:1px solid}ul{margin:0;padding:0;width:200px;max-height:120px;overflow-y:auto}li{height:40px;list-style:none;cursor:pointer}input{margin:20px}</style>
<label>Education</label><div id="picker" role="combobox" tabindex="0" aria-controls="options"><span id="display">School</span><input type="hidden" value="school"></div>
<ul id="options" role="listbox" hidden>${["School", "Certificate", "Training", "Diploma", "Associate", "College", "Master", "Doctorate"].map((s) => `<li role="option">${s}</li>`).join("")}</ul>
<label>Address<input aria-label="Address" value="East"></label><button id="save">Save</button><script>window.clicks=0;window.saves=0;const picker=document.getElementById('picker'),options=document.getElementById('options');picker.onclick=()=>{window.clicks++;options.hidden=!options.hidden;document.getElementById('display').textContent=picker.querySelector('input').value==='school'?'School '+(options.hidden?'▼':'▲'):'College '+(options.hidden?'▼':'▲')};for(const li of options.children)li.onclick=()=>{window.clicks++;picker.querySelector('input').value=li.textContent.toLowerCase();document.getElementById('display').textContent=li.textContent;options.hidden=true};document.getElementById('save').onclick=()=>window.saves++;</script>`;

test(
  "iframe picker reveals clipped options with native input and distinguishes unrelated overlays",
  { skip: process.env["RUN_FORM_REPAIR_E2E"] !== "1", timeout: 120000 },
  async (t) => {
    const fixture = await browserTestFixture((path) =>
      path.startsWith("/frame")
        ? form
        : '<iframe id="frame" src="/frame" style="width:1100px;height:800px"></iframe>',
    );
    const c = fixture.controller;
    try {
      await c.navigate(fixture.origin);
      for (let i = 0; i < 80; i++) {
        if (
          await c.evaluateJson(
            'Boolean(document.querySelector("iframe")?.contentDocument?.getElementById("picker"))',
          )
        ) {
          break;
        }
        await delay(25);
      }
      await t.test("clipping is revealable; an overlay and overflow:hidden are not", async () => {
        const expression = (extra: string) =>
          `(()=>{const d=document.querySelector('iframe').contentDocument;d.getElementById('options').hidden=false;${extra};return (${INSPECT_GOAL_CONTROL}).call(d.querySelectorAll('li')[5],${JSON.stringify([fixture.origin])})})()`;
        assert.equal(
          GoalControlSchema.parse(await c.evaluateJson(expression(""))).availability,
          "offscreen",
        );
        assert.equal(
          GoalControlSchema.parse(
            await c.evaluateJson(
              expression("d.getElementById('options').style.overflowY='hidden'"),
            ),
          ).availability,
          "covered",
        );
        assert.equal(
          GoalControlSchema.parse(
            await c.evaluateJson(
              expression(
                "d.getElementById('options').style.overflowY='auto';const cover=d.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;background:white;z-index:100';d.body.append(cover)",
              ),
            ),
          ).availability,
          "covered",
        );
        await c.evaluateJson(
          "const d=document.querySelector('iframe').contentDocument;d.getElementById('cover').remove();d.getElementById('options').hidden=true",
        );
      });
      const signal = AbortSignal.timeout(90000);
      const browserInstance = "form-repair";
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
        model: "jev-1.13.0",
        strategy: "task",
        goal: "Set Education to College degree using its dropdown, then close the menu. Keep Address unchanged. Do not Save.",
        values: [{ name: "education", text: "College degree" }],
        formTask: {
          mode: "edit",
          fields: [
            { name: "Education", intent: "set", valueName: "education" },
            { name: "Address", intent: "preserve" },
          ],
        },
        allowedOrigins: [fixture.origin],
        blockedNames: ["Save"],
        maxSteps: 20,
      });
      const stub: DecisionProvider = async (request) => {
        const state = z
          .object({
            elements: z.array(z.object({ ref: z.string(), name: z.string(), role: z.string() })),
            executionContext: z.object({
              form: z.object({
                fields: z.array(z.object({ name: z.string(), current: z.string().optional() })),
              }),
            }),
          })
          .parse(request.state);
        const choices: Record<string, string> = { operation: "WAIT" };
        for (const key of Object.keys(request.questions)) {
          if (key === "form_bind_f1") {
            choices[key] = state.elements.find((e) => e.role === "combobox")!.ref;
          }
          if (key === "form_bind_f2") {
            choices[key] = state.elements.find(
              (e) => e.name === "Address" && e.role === "textbox",
            )!.ref;
          }
          if (key === "form_target_f1") {
            choices[key] = Object.entries(request.questions[key]!.criteria).find(
              ([, label]) => label === "College",
            )![0];
          }
          if (key === "form_value_f1") {
            choices[key] = state.executionContext.form.fields[0]?.current?.includes("College")
              ? "satisfied"
              : "unsatisfied";
          }
        }
        const operations = request.questions.operation!.criteria;
        const option = state.elements.find((e) => e.name === "College");
        const trigger = state.elements.find((e) => e.role === "combobox");
        if (operations.DONE) choices.operation = "DONE";
        else if (option && operations[`CLICK:${option.ref}`]) {
          choices.operation = `CLICK:${option.ref}`;
        } else if (trigger && operations[`CLICK:${trigger.ref}`]) {
          choices.operation = `CLICK:${trigger.ref}`;
        }
        return {
          choices,
          elapsedMs: 0,
          provider: "test",
          requestedModel: "test",
          resolvedModel: "test",
        };
      };
      const decide =
        process.env["RUN_FORM_REPAIR_LIVE_JEV"] === "1"
          ? createJevProvider({ apiKey: process.env["TYPESAFE_API_KEY"]!, model: "jev-1.13.0" })
          : stub;
      const result = await runBrowserTask(
        input,
        {
          observe,
          checkTarget: async () => true,
          invoke: async (m, p) => driver.invoke(m, p),
          actionExecuted: () => driver.lastActionExecuted,
        },
        decide,
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
      const oracle = await c.evaluateJson(
        "(()=>{const w=document.querySelector('iframe').contentWindow,d=w.document;return {selected:d.querySelector('#picker input').value,closed:d.getElementById('options').hidden,address:d.querySelector('[aria-label=Address]').value,clicks:w.clicks,saves:w.saves}})()",
      );
      assert.deepEqual(oracle, {
        selected: "college",
        closed: true,
        address: "East",
        clicks: 2,
        saves: 0,
      });
    } finally {
      await fixture.close();
    }
  },
);

test(
  "shared-label fields expose local visual peer order without inferring their business meaning",
  { skip: process.env["RUN_FORM_REPAIR_E2E"] !== "1", timeout: 30000 },
  async () => {
    const fixture = await browserTestFixture(
      () =>
        '<style>#range{display:flex}#upper{order:2}#lower{order:1}#months{order:3}</style><div id="range"><input id="upper" value="8k"><input id="lower" value="7k"><input id="months" value="12"></div><input id="unrelated" value="other">',
    );
    try {
      const c = fixture.controller;
      await c.navigate(fixture.origin);
      for (let i = 0; i < 80; i++) {
        if (await c.evaluateJson('Boolean(document.getElementById("lower"))')) break;
        await delay(25);
      }
      const rows = await Promise.all(
        ["lower", "upper", "months"].map(async (id) =>
          GoalControlSchema.parse(
            await c.evaluateJson(
              `(${INSPECT_GOAL_CONTROL}).call(document.getElementById(${JSON.stringify(id)}),${JSON.stringify([fixture.origin])})`,
            ),
          ),
        ),
      );
      assert.deepEqual(
        rows.map((r) => r.peerGroup?.position),
        [1, 2, 3],
      );
      assert.deepEqual(
        rows.map((r) => r.peerGroup?.count),
        [3, 3, 3],
      );
      assert.equal(new Set(rows.map((r) => r.peerGroup?.key)).size, 1);
    } finally {
      await fixture.close();
    }
  },
);
