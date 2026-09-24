import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  BrowserScriptPageDriver,
  NativeCdpController,
  readBrowserDocumentIdentity,
} from "@roll-agent/browser";
import { observeBrowserPage } from "../browser-observation.ts";
import { browserElementRefStore } from "../element-ref-store.ts";
import { canonicalJson } from "../workflows/parameters.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import type { DecisionRequest, DecisionProvider } from "./decisions.ts";
import { createJevProvider } from "./decisions.ts";
import { permittedFrames } from "./host.ts";
import { inspectGoalControls } from "./observation.ts";
import type { GoalSnapshot } from "./observation.ts";
import { semanticGoalControl } from "./task-freshness.ts";
import { createDependencyObserver } from "./dependency-observation.ts";
import { runBrowserTask } from "./task-loop.ts";
import { attachTaskText } from "./task-observation.ts";
import { taskElements, taskNodes } from "./task-policy.ts";

const TITLE = "门店运营助理";
const CITY = "上海市";
const DISTRICT = "浦东新区";
const PAY = "200元/日";
const FIXTURE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Generic dependent form</title>
<style>body{font:16px sans-serif;padding:16px}.field{margin:12px 0;padding:8px;width:560px}label,legend{display:block;margin-bottom:6px}input,select,button{font:inherit;padding:8px}input:not([type=radio]),select{width:350px}button{cursor:pointer}ul{padding:0;list-style:none}dialog{padding:24px;width:430px}dialog label{padding:8px}output{display:block;padding:8px}</style>
<div id="clock" role="timer">clock 0</div><form id="form">
<section class="field" id="title-field"><label for="title">岗位标题</label><input id="title" aria-label="岗位标题" required></section>
<section class="field" id="city-field" role="group" aria-label="城市字段"><label for="city">城市</label><input id="city" aria-label="城市" role="combobox" aria-autocomplete="list" aria-controls="city-options" aria-expanded="false" required autocomplete="off"><ul id="city-options" role="listbox" hidden></ul></section>
<section class="field" id="district-field"><label for="district">行政区</label><select id="district" aria-label="行政区" required disabled><option value="">先选择城市</option></select></section>
<section class="field" id="pay-field"><span>日薪</span><button id="pay" type="button" aria-label="日薪" aria-haspopup="dialog" aria-controls="pay-dialog" aria-expanded="false">请选择</button></section>
<button id="check" type="button">检查草稿</button><output id="status" role="status">待检查</output></form>
<dialog id="pay-dialog" aria-label="日薪选择"><fieldset><legend>选择日薪</legend><label><input type="radio" name="daily" value="200" aria-label="200元/日">200元/日</label><label><input type="radio" name="daily" value="300" aria-label="300元/日">300元/日</label></fieldset><button id="confirm-pay" type="button" disabled>确认日薪</button></dialog>
<script>
const form=document.getElementById('form'),city=document.getElementById('city'),list=document.getElementById('city-options'),district=document.getElementById('district'),pay=document.getElementById('pay'),dialog=document.getElementById('pay-dialog'),confirmPay=document.getElementById('confirm-pay'),status=document.getElementById('status');
const state=window.fixtureState={titleInputs:0,citySelections:0,titleClones:0,districtChanges:0,payOpens:0,payConfirms:0,checks:0,submitted:0};let timer;
form.addEventListener('submit',event=>{event.preventDefault();state.submitted++});
form.addEventListener('input',event=>{if(event.target.id==='title')state.titleInputs++});
city.addEventListener('input',()=>{clearTimeout(timer);city.setAttribute('aria-expanded','true');list.replaceChildren();list.hidden=true;timer=setTimeout(()=>{const item=document.createElement('li'),button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.textContent='上海市';button.onclick=()=>{state.citySelections++;city.value='上海市';city.setAttribute('aria-expanded','false');list.hidden=true;const title=document.getElementById('title'),clone=title.cloneNode(true);clone.value=title.value;title.replaceWith(clone);state.titleClones++;district.replaceChildren(new Option('请选择行政区',''),new Option('浦东新区','pudong'),new Option('徐汇区','xuhui'));district.disabled=false;};item.append(button);list.append(item);list.hidden=false},80)});
district.addEventListener('change',()=>state.districtChanges++);
pay.onclick=()=>{state.payOpens++;pay.setAttribute('aria-expanded','true');dialog.showModal()};
dialog.addEventListener('change',()=>{confirmPay.disabled=!dialog.querySelector('input:checked')});
confirmPay.onclick=()=>{const selected=dialog.querySelector('input:checked');if(!selected)return;state.payConfirms++;pay.textContent=selected.value+'元/日';pay.setAttribute('aria-expanded','false');dialog.close()};
document.getElementById('check').onclick=()=>{state.checks++;const ok=document.getElementById('title').value==='门店运营助理'&&city.value==='上海市'&&state.citySelections===1&&district.value==='pudong'&&pay.textContent==='200元/日'&&state.payConfirms===1&&!dialog.open;status.textContent=ok?'检查通过':'检查未通过'};
</script></html>`;

function offered(
  request: DecisionRequest,
  choices: Record<string, string>,
): ReturnType<DecisionProvider> {
  const targetHead = (choices.operation ?? "").toLowerCase() + "_target";
  if (choices[targetHead]) {
    choices = { ...choices, operation: `${choices.operation}:${choices[targetHead]}` };
    delete choices[targetHead];
  }
  if (choices.operation === "DONE") choices.completion = "COMPLETE";
  for (const [name, value] of Object.entries(choices)) {
    assert.ok(
      request.questions[name]?.criteria[value],
      `Unavailable observed action ${name}=${value}`,
    );
  }
  return Promise.resolve({
    choices,
    requestedModel: "deterministic-fixture",
    resolvedModel: "deterministic-fixture",
    provider: "offline-stub",
    elapsedMs: 0,
  });
}

test(
  "goal loop completes a dependent real DOM form through native CDP observations and public actions",
  {
    skip: process.env["RUN_GOAL_TASK_E2E"] !== "1",
    timeout: 120000,
  },
  async (t) => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(FIXTURE);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "roll-goal-task-e2e-"));
    const chrome = spawn(
      process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-size=1280,1100",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let spawnError: Error | undefined;
    chrome.once("error", (error) => {
      spawnError = error;
    });
    const exited = new Promise<void>((resolve) => {
      chrome.once("exit", () => resolve());
      chrome.once("error", () => resolve());
    });
    let controller: NativeCdpController | undefined;
    let driver: BrowserScriptPageDriver | undefined;
    let pageId: string | undefined;
    try {
      let port = "";
      for (let attempt = 0; attempt < 100 && !port; attempt++) {
        if (spawnError) throw spawnError;
        try {
          port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0] ?? "";
        } catch {
          await delay(50);
        }
      }
      assert.ok(port, "Owned headless browser did not expose CDP");
      const tabs = z
        .array(
          z.object({
            id: z.string(),
            type: z.string(),
            webSocketDebuggerUrl: z.string().optional(),
          }),
        )
        .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      const tab = tabs.find((candidate) => candidate.type === "page");
      assert.ok(tab?.webSocketDebuggerUrl);
      pageId = tab.id;
      controller = await NativeCdpController.connect({
        webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
      });
      const activeController = controller;
      await activeController.navigate(origin + "/fixture");
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await activeController.evaluateJson('Boolean(document.getElementById("title"))')) break;
        await delay(25);
      }
      const browserInstance = `goal-task-e2e-${randomUUID()}`;
      const signal = AbortSignal.timeout(90000);
      let latest: GoalSnapshot | undefined;
      let observations = 0;
      let rootFrameOmitted = false;
      let modalBackgroundUnavailable = false;
      let nativeModalObserved = false;
      const titleBackends = new Set<number>();
      const handles = new Map<number, Set<string>>();
      const actions: { method: string; name: string; role: string; ref: string }[] = [];
      const decisionInputs: unknown[] = [];
      const actionScopes: unknown[] = [];
      const observed = () => {
        assert.ok(latest);
        return latest;
      };
      const controlFor = (name: string) =>
        taskElements(observed()).find(
          (element) =>
            element.name === name && ["ready", "offscreen"].includes(element.availability),
        );
      const observeDependencies = createDependencyObserver(activeController, [origin], signal);
      const observe = async (identities: readonly string[] = []): Promise<GoalSnapshot> => {
        const tree = await activeController.getFrameTree();
        const snapshot = await observeBrowserPage({
          controller: activeController,
          page: { targetId: tab.id },
          browserInstance,
          allowedOrigins: [origin],
          allowedFrameIds: permittedFrames(tree, [origin]),
          maxNodes: 240,
          interactiveOnly: true,
        });
        const inspected = await inspectGoalControls(activeController, snapshot, [origin], signal);
        latest = await observeDependencies(
          await attachTaskText(activeController, inspected, [origin], signal),
          identities,
        );
        observations += 1;
        for (const ref of latest.refs) {
          if (ref.name === "岗位标题" && ref.role === "textbox") {
            rootFrameOmitted ||= ref.frameId === undefined;
            if (ref.backendNodeId !== undefined) titleBackends.add(ref.backendNodeId);
          }
          if (ref.backendNodeId !== undefined) {
            const seen = handles.get(ref.backendNodeId) ?? new Set<string>();
            seen.add(ref.ref);
            handles.set(ref.backendNodeId, seen);
          }
        }
        const modal = taskNodes(latest.nodes).some(
          (node) => node.role.toLowerCase() === "dialog" && node.properties?.modal === true,
        );
        nativeModalObserved ||= modal;
        if (modal) {
          const background = taskElements(latest).find(
            (element) => element.name === "岗位标题" && element.role === "textbox",
          );
          modalBackgroundUnavailable ||=
            background === undefined || !["ready", "offscreen"].includes(background.availability);
        }
        return latest;
      };
      driver = new BrowserScriptPageDriver({
        controller: activeController,
        pageId: tab.id,
        browserInstance,
        allowedOrigins: [origin],
        capabilities: ["read", "interact"],
        signal,
        guard: async () => {
          signal.throwIfAborted();
        },
        observe: () => observe(),
        resolveRef: async (ref, snapshotId) =>
          browserElementRefStore.getScopedRef({
            ref,
            snapshotId,
            browserInstance,
            pageId: tab.id,
            documentId: await readBrowserDocumentIdentity(activeController),
          }),
        capture: async () => {
          throw new Error("This goal test does not capture screenshots");
        },
      });
      await t.test("a fresh native driver dismisses a dialog with page Escape", async () => {
        await activeController.evaluateJson(
          'document.getElementById("pay-dialog").showModal(); true',
        );
        await driver!.invoke("press", ["Escape"]);
        assert.equal(driver!.lastActionExecuted, true);
        assert.equal(
          await activeController.evaluateJson('document.getElementById("pay-dialog").open'),
          false,
        );
      });
      const publicDriver = driver;
      const liveJev =
        process.env["RUN_GOAL_TASK_LIVE_JEV"] === "1"
          ? createJevProvider({
              apiKey: process.env["TYPESAFE_API_KEY"] ?? "",
              model: "jev-1.13.0",
            })
          : undefined;
      const task = BrowserOperateInputSchema.parse({
        pageId: tab.id,
        goal: "日薪的单位为元/日。先填写岗位标题，再从候选选择城市，选择联动行政区，在日薪弹窗选择并确认日薪，最后点击检查草稿，看到检查通过后结束。不得提交。",
        values: [
          { name: "岗位标题", text: TITLE },
          { name: "城市", text: CITY },
          { name: "行政区", text: DISTRICT },
          { name: "日薪", text: "200" },
        ],
        allowedOrigins: [origin],
        maxSteps: 40,
        maxTextCalls: 48,
        timeoutMs: 90000,
      });
      const result = await runBrowserTask(
        task,
        {
          observe,
          invoke: async (method, args) => {
            const locator = z.object({ ref: z.string() }).parse(args[0]);
            const ref = observed().refs.find((candidate) => candidate.ref === locator.ref);
            assert.ok(ref, "Every action must use a current observed ref");
            actions.push({ method, name: ref.name, role: ref.role, ref: ref.ref });
            if (ref.name === CITY) {
              const rootRef = observed().refs.find(
                (candidate) => candidate.name === "城市" && candidate.role === "combobox",
              );
              actionScopes.push({
                target: ref,
                targetControl: observed().controls?.[ref.ref],
                root: rootRef,
                rootControl: rootRef ? observed().controls?.[rootRef.ref] : undefined,
              });
            }
            return publicDriver.invoke(method, args);
          },
          actionExecuted: () => publicDriver.lastActionExecuted,
          checkTarget: async (snapshot, ref) => {
            if ((await readBrowserDocumentIdentity(activeController)) !== snapshot.documentId) {
              return false;
            }
            const fresh = await inspectGoalControls(
              activeController,
              { ...snapshot, refs: [ref] },
              [origin],
              signal,
            );
            const before = snapshot.controls?.[ref.ref];
            const after = fresh.controls?.[ref.ref];
            return Boolean(
              before &&
              after &&
              after.availability !== "unavailable" &&
              canonicalJson(semanticGoalControl(before)) ===
                canonicalJson(semanticGoalControl(after)),
            );
          },
        },
        async (request, decisionSignal) => {
          decisionInputs.push({
            elements: taskElements(observed()).map(
              ({ ref, name, role, editable, readonly, nativeSelect, value }) => ({
                ref,
                name,
                role,
                editable,
                readonly,
                nativeSelect,
                value,
              }),
            ),
            actions: request.questions.operation?.criteria,
          });
          if (liveJev) return liveJev(request, decisionSignal);
          const elements = taskElements(observed());
          const click = (name: string, role?: string) => {
            const element = elements.find(
              (candidate) =>
                candidate.name === name &&
                (!role || candidate.role === role) &&
                ["ready", "offscreen"].includes(candidate.availability),
            );
            assert.ok(element, `Expected an observed actionable ${name}`);
            return offered(request, { operation: "CLICK", click_target: element.ref });
          };
          const radio = elements.find(
            (element) =>
              element.name === PAY &&
              element.role === "radio" &&
              ["ready", "offscreen"].includes(element.availability),
          );
          if (radio) {
            return radio.checked === true ? click("确认日薪", "button") : click(PAY, "radio");
          }
          const title = controlFor("岗位标题");
          if (title && title.value !== TITLE) {
            return offered(request, {
              operation: "TYPE_TEXT",
              type_text_target: title.ref,
              [request.routing!.targets[`TYPE_TEXT:${title.ref}`]!]: "v1",
            });
          }
          const city = controlFor("城市");
          if (city?.expanded && city.value === CITY) {
            assert.ok(request.questions["operation"]?.criteria["WAIT"]);
            assert.ok(request.questions["operation"]?.criteria["REASSESS"]);
          }
          const candidate = elements.find(
            (element) =>
              ["option", "button"].includes(element.role) &&
              element.name === CITY &&
              element.availability === "ready",
          );
          if (candidate) {
            return offered(request, { operation: "CLICK", click_target: candidate.ref });
          }
          if (city && city.value !== CITY) {
            return offered(request, {
              operation: "TYPE_TEXT",
              type_text_target: city.ref,
              [request.routing!.targets[`TYPE_TEXT:${city.ref}`]!]: "v2",
            });
          }
          if (city?.expanded) return offered(request, { operation: "WAIT" });
          const district = controlFor("行政区");
          if (district?.nativeSelect && !district.disabled) {
            const choice = district.options?.findIndex(
              (option) => option.label === DISTRICT && !option.disabled,
            );
            if (
              choice !== undefined &&
              choice >= 0 &&
              district.options?.[choice]?.selected !== true
            ) {
              return offered(request, {
                operation: "SELECT",
                select_target: `${district.ref}:${choice}`,
              });
            }
          }
          const pay = controlFor("日薪");
          const payDisplay = pay ? observed().controls?.[pay.ref]?.displayText : undefined;
          if (pay && payDisplay !== PAY) return click("日薪", "button");
          if (!observed().pageText?.includes("检查通过")) return click("检查草稿", "button");
          return offered(request, { operation: "DONE" });
        },
        signal,
      );
      const oracle = z
        .object({
          title: z.string(),
          city: z.string(),
          district: z.string(),
          payLabel: z.string(),
          payDisplay: z.string(),
          dialogOpen: z.boolean(),
          status: z.string(),
          state: z.object({
            titleInputs: z.number(),
            citySelections: z.number(),
            titleClones: z.number(),
            districtChanges: z.number(),
            payOpens: z.number(),
            payConfirms: z.number(),
            checks: z.number(),
            submitted: z.number(),
          }),
        })
        .parse(
          await activeController.evaluateJson(
            `({title:document.getElementById('title').value,city:document.getElementById('city').value,district:document.getElementById('district').value,payLabel:document.getElementById('pay').getAttribute('aria-label'),payDisplay:document.getElementById('pay').textContent,dialogOpen:document.getElementById('pay-dialog').open,status:document.getElementById('status').textContent,state:window.fixtureState})`,
          ),
        );
      const diagnostic = {
        status: result.status,
        error: result.error,
        pending: result.pendingRequirements,
        fieldEvidence: result.fieldEvidence,
        steps: result.steps.map(({ operation, target, error }) => ({ operation, target, error })),
        actions,
        decisionInputs,
        actionScopes,
        oracle,
        observations,
        rootFrameOmitted,
        nativeModalObserved,
        modalBackgroundUnavailable,
        titleBackends: [...titleBackends],
        observedElements: taskElements(observed()).map(
          ({ ref, role, name, value, availability }) => ({ ref, role, name, value, availability }),
        ),
        candidateDOM: await activeController.evaluateJson(
          "({hidden:document.getElementById('city-options').hidden,text:document.getElementById('city-options').textContent,children:document.getElementById('city-options').children.length})",
        ),
      };
      assert.equal(result.status, "model_done", JSON.stringify(diagnostic));
      assert.equal(
        result.steps.some((step) => step.operation === "STALE_ASSISTANCE"),
        false,
      );
      assert.deepEqual(
        {
          title: oracle.title,
          city: oracle.city,
          district: oracle.district,
          pay: oracle.payDisplay,
          status: oracle.status,
        },
        { title: TITLE, city: CITY, district: "pudong", pay: PAY, status: "检查通过" },
      );
      assert.equal(oracle.payLabel, "日薪");
      assert.equal(oracle.dialogOpen, false);
      assert.equal(oracle.state.titleInputs, 1);
      assert.equal(oracle.state.citySelections, 1);
      assert.equal(oracle.state.titleClones, 1);
      assert.equal(oracle.state.districtChanges, 1);
      assert.equal(oracle.state.payOpens, 1);
      assert.equal(oracle.state.payConfirms, 1);
      assert.equal(oracle.state.checks, 1);
      assert.equal(oracle.state.submitted, 0);
      assert.deepEqual(
        actions
          .filter(({ method, name }) => method !== "click" || !["城市", "行政区"].includes(name))
          .map(({ method, name }) => ({ method, name })),
        [
          { method: "fill", name: "岗位标题" },
          { method: "fill", name: "城市" },
          { method: "click", name: CITY },
          { method: "choose", name: "行政区" },
          { method: "click", name: "日薪" },
          { method: "click", name: PAY },
          { method: "click", name: "确认日薪" },
          { method: "click", name: "检查草稿" },
        ],
        "Field changes must preserve explicit order; focusing a control before filling/choosing is allowed",
      );
      for (const name of ["城市", "行政区"]) {
        assert.ok(
          actions.filter((action) => action.method === "click" && action.name === name).length <= 2,
          "Focusing a control must not become an ineffective click loop",
        );
      }
      assert.equal(
        actions.filter((action) => action.method === "fill" && action.name === "岗位标题").length,
        1,
      );
      assert.equal(
        titleBackends.size,
        2,
        "The real title DOM clone must have a distinct backend identity",
      );
      assert.equal(
        rootFrameOmitted,
        true,
        "Exercise the production adapter's optional root frameId",
      );
      assert.equal(nativeModalObserved, true);
      assert.equal(modalBackgroundUnavailable, true);
      assert.deepEqual(result.textCalls, []);
      assert.equal(result.recoveryDecisions, 0);
      t.diagnostic(
        JSON.stringify({
          engine: liveJev ? "jev-live" : "offline-stub",
          firstDecisionInput: decisionInputs[0],
          elapsedMs: result.elapsedMs,
          decisionMs: result.steps.reduce((sum, step) => sum + step.decisionMs, 0),
          decisions: result.steps.length,
          textCalls: result.textCalls,
          observations,
          actions,
          rootFrameOmitted,
          titleBackendCount: titleBackends.size,
          stableBackendRefChanges: [...handles.values()].filter((refs) => refs.size > 1).length,
          nativeModalObserved,
          modalBackgroundUnavailable,
          oracle,
        }),
      );
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
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
