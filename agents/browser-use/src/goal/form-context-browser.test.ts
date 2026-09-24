import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
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
import type { DecisionProvider } from "./decisions.ts";

const html = (
  path: string,
) => `<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif;padding:20px}label{display:block;margin:12px}input,select,button{font:inherit;padding:8px}dialog{padding:30px}dialog::backdrop{background:#5558}</style><h1>Record settings</h1>
<label>Category<select aria-label="Category" id="category"><option>Old</option><option>New</option></select></label>
<p>Changing Category resets Pay and Education.</p>
<label>Pay<input aria-label="Pay" id="pay" value="5" ${path === "/modal" || path === "/staged" ? "readonly" : ""}></label>
<label>Education<input aria-label="Education" id="education" value="School"></label>
<label>Address<input aria-label="Address" id="address" value="East"></label>
<label>Audit<input aria-label="Audit" id="audit" value="initial" readonly></label>
<button id="save">Save</button>
<dialog id="editor" aria-label="Pay settings"><h2>Pay settings</h2><label>Pay<input aria-label="Pay" id="editor-pay" value="5"></label><button id="apply">Apply</button><button id="cancel">Cancel</button></dialog>
<script>window.events={payInputs:0,educationInputs:0,addressInputs:0,categoryChanges:0,opens:0,applies:0,saves:0};const pay=document.getElementById('pay'),education=document.getElementById('education'),address=document.getElementById('address'),editor=document.getElementById('editor');pay.oninput=()=>events.payInputs++;education.oninput=()=>events.educationInputs++;address.oninput=()=>events.addressInputs++;document.getElementById('category').onchange=()=>{events.categoryChanges++;pay.value='';education.value='';document.getElementById('audit').value='category adjusted';${path === "/preserve" ? 'address.value="West";' : ""}};${path === "/modal" || path === "/staged" ? "pay.onclick=()=>{events.opens++;document.getElementById('editor-pay').value=pay.value;editor.showModal()};" : ""}document.getElementById('apply').onclick=()=>{events.applies++;pay.value=document.getElementById('editor-pay').value;editor.close()};document.getElementById('cancel').onclick=()=>editor.close();document.getElementById('save').onclick=()=>events.saves++;${path === "/staged" ? "editor.showModal();" : ""}</script>`;

test(
  "shared form execution handles dependencies, editor application and write-scope boundaries",
  { skip: process.env["RUN_FORM_CONTEXT_E2E"] !== "1", timeout: 240000 },
  async (t) => {
    const fixture = await browserTestFixture(html);
    const c = fixture.controller;
    try {
      for (const path of ["/dependency", "/modal", "/staged", "/outside", "/preserve"]) {
        await t.test(path, async () => {
          await c.navigate(fixture.origin + path);
          for (let i = 0; i < 80; i++) {
            if (await c.evaluateJson('Boolean(document.getElementById("pay"))')) break;
            await delay(25);
          }
          const browserInstance = `form-${path}`;
          const signal = AbortSignal.timeout(50000);
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
              throw Error("No screenshot action");
            },
          });
          const values = [
            { name: "Category", text: "New" },
            { name: "Pay", text: "8" },
            { name: "Education", text: "College" },
          ];
          const fields =
            path === "/modal" || path === "/staged"
              ? [{ name: "Pay", intent: "set", valueName: "Pay" }]
              : path === "/outside"
                ? [{ name: "Category", intent: "set", valueName: "Category" }]
                : path === "/preserve"
                  ? [
                      { name: "Category", intent: "set", valueName: "Category" },
                      { name: "Address", intent: "preserve" },
                    ]
                  : [
                      { name: "Category", intent: "set", valueName: "Category" },
                      { name: "Pay", intent: "set", valueName: "Pay" },
                      { name: "Education", intent: "set", valueName: "Education" },
                      { name: "Address", intent: "preserve" },
                    ];
          let goal =
            path === "/modal" || path === "/staged"
              ? "Set Pay to 8 using the Pay editor and Apply it to the main form, then close the editor. Do not Save."
              : path === "/outside"
                ? "Set only Category to New. Report any other changes, but do not repair them. Do not Save."
                : path === "/preserve"
                  ? "Set Category to New, do not write Address and report if its original value changes. Do not Save."
                  : "Set Category to New, Pay to 8 and Education to College. Do not write Address. Do not Save.";
          if (path === "/staged") {
            goal =
              "In the currently open Pay editor, set Pay to 8 and leave it open. Do not Apply or Save; the main form must stay unchanged.";
          }
          const input = BrowserOperateInputSchema.parse({
            pageId: fixture.pageId,
            engine: "jev",
            model: "jev-1.13.0",
            allowedOrigins: [fixture.origin],
            values,
            goal,
            formTask: {
              mode: "edit",
              fields,
              stopAt: path === "/staged" ? "current-view" : "applied",
            },
            blockedNames: ["Save"],
            maxSteps: 45,
          });
          const stub: DecisionProvider = async (request) => {
            const state = z
              .object({
                executionContext: z.object({
                  form: z.object({
                    fields: z.array(
                      z.object({ id: z.string(), name: z.string(), status: z.string() }),
                    ),
                  }),
                }),
                elements: z.array(
                  z.object({
                    ref: z.string(),
                    name: z.string(),
                    role: z.string(),
                    readonly: z.unknown().optional(),
                    availability: z.string().optional(),
                  }),
                ),
              })
              .parse(request.state);
            const answers: Record<string, string> = { operation: "WAIT" };
            for (const [key, q] of Object.entries(request.questions)) {
              if (key.startsWith("form_bind_")) {
                const f = state.executionContext.form.fields.find(
                  (f) => key === `form_bind_${f.id}`,
                )!;
                const option = Object.entries(q.criteria).find(([id]) =>
                  state.elements.some((e) => e.ref === id && e.name === f.name),
                );
                answers[key] = option?.[0] ?? "NONE";
              } else if (key.startsWith("form_target_")) {
                const field = state.executionContext.form.fields.find(
                  (f) => key === `form_target_${f.id}`,
                );
                assert.equal(field?.name, "Category", "Only Category is an enum in this fixture");
                const option = Object.entries(q.criteria).find(([, label]) => label === "New");
                assert.ok(option, "The native Category options must include New");
                answers[key] = option[0];
              }
            }
            if (request.questions.form_panel) answers.form_panel = "MATCH";
            // The Pay dialog contains a value editor, not a selector search box.
            if (request.questions.form_search) answers.form_search = "NONE";
            const actions = Object.entries(request.questions.operation!.criteria);
            let chosen = actions.find(
              ([key, label]) => key.startsWith("SELECT:") && label.includes("New"),
            );
            chosen ??= actions.find(([key]) => key.startsWith("TYPE_TEXT:"));
            chosen ??= actions.find(
              ([key, label]) => key.startsWith("CLICK:") && label.includes("Apply"),
            );
            chosen ??= actions.find(
              ([key, label]) => key.startsWith("CLICK:") && label.includes("Pay"),
            );
            if (chosen) {
              answers.operation = chosen[0];
              if (chosen[0].startsWith("TYPE_TEXT:")) {
                const head = request.routing?.targets[chosen[0]];
                assert.ok(head);
                const name = state.elements.find((e) => e.ref === chosen[0].slice(10))?.name;
                answers[head] = name === "Pay" ? "v2" : "v3";
              }
            } else if (request.questions.operation!.criteria.DONE) {
              answers.operation = "DONE";
              answers.completion = "COMPLETE";
            }
            return {
              choices: answers,
              provider: "fixture",
              requestedModel: "fixture",
              resolvedModel: "fixture",
              elapsedMs: 0,
            };
          };
          const decide =
            process.env["RUN_FORM_CONTEXT_LIVE_JEV"] === "1"
              ? createJevProvider({
                  apiKey: process.env["TYPESAFE_API_KEY"] ?? "",
                  model: "jev-1.13.0",
                })
              : stub;
          try {
            const result = await runBrowserTask(
              input,
              {
                observe,
                invoke: (m, args) => driver.invoke(m, args),
                actionExecuted: () => driver.lastActionExecuted,
              },
              decide,
              signal,
            );
            const actual = z
              .object({
                category: z.string(),
                pay: z.string(),
                education: z.string(),
                address: z.string(),
                open: z.boolean(),
                events: z.record(z.number()),
              })
              .parse(
                await c.evaluateJson(
                  '({category:document.getElementById("category").value,pay:document.getElementById("pay").value,education:document.getElementById("education").value,address:document.getElementById("address").value,open:document.getElementById("editor").open,events:window.events})',
                ),
              );
            assert.equal(
              result.status,
              path === "/preserve" ? "needs_reasoning" : "interaction_done",
              JSON.stringify({
                status: result.status,
                error: result.error,
                steps: result.steps.map((s) => [s.operation, s.target, s.error]),
                execution: result.execution,
              }),
            );
            assert.equal(actual.events.saves, 0);
            assert.equal(actual.events.addressInputs, 0);
            assert.deepEqual(result.textCalls, []);
            if (path === "/dependency") {
              assert.equal(actual.category, "New");
              assert.equal(actual.pay, "8");
              assert.equal(actual.education, "College");
              assert.equal(actual.address, "East");
            }
            if (path === "/modal") {
              assert.equal(actual.pay, "8");
              assert.equal(actual.open, false);
              assert.equal(actual.events.applies, 1);
            }
            if (path === "/staged") {
              assert.equal(actual.pay, "5");
              assert.equal(actual.open, true);
              assert.equal(actual.events.applies, 0);
              assert.equal(
                await c.evaluateJson('document.getElementById("editor-pay").value'),
                "8",
              );
            }
            if (path === "/outside") {
              assert.equal(actual.pay, "");
              assert.equal(actual.events.payInputs, 0);
              assert.ok(
                result.execution?.changes.some(
                  (c) => c.field === "Pay" && c.scope === "unassigned",
                ),
              );
            }
            if (path === "/preserve") {
              assert.equal(actual.address, "West");
              assert.ok(result.execution?.changes.some((c) => c.scope === "preserved"));
            }
            t.diagnostic(
              JSON.stringify({
                path,
                engine: process.env["RUN_FORM_CONTEXT_LIVE_JEV"] === "1" ? "jev" : "fixture",
                elapsedMs: result.elapsedMs,
                steps: result.steps.length,
                status: result.status,
                actual,
              }),
            );
          } finally {
            driver.close();
            browserElementRefStore.clear(fixture.pageId);
          }
        });
      }
    } finally {
      await fixture.close();
    }
  },
);
