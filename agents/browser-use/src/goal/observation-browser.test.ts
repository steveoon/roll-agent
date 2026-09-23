import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { NativeCdpController } from "@roll-agent/browser";
import { INSPECT_GOAL_CONTROL, GoalControlSchema } from "./observation.ts";

test(
  "real DOM observation preserves local context, visual order and field evidence",
  { skip: process.env["RUN_GOAL_OBSERVATION_E2E"] !== "1", timeout: 30000 },
  async (t) => {
    let html =
      '<form><section><label for="amount">Amount</label><div><input id="amount" aria-describedby="units"><small id="units">元/月</small></div></section><section><label>Category<select id="other"><option>Other category</option></select></label></section></form>';
    let frameHtml = "";
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(req.url?.startsWith("/frame") ? frameHtml : html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "jev-observation-"));
    const chrome = spawn(
      process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let controller: NativeCdpController | undefined;
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
        .array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() }))
        .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      const tab = tabs.find((t) => t.type === "page");
      assert.ok(tab?.webSocketDebuggerUrl);
      controller = await NativeCdpController.connect({
        webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
      });
      await controller.navigate(origin);
      for (let i = 0; i < 40; i++) {
        if (await controller.evaluateJson('Boolean(document.getElementById("amount"))')) break;
        await delay(25);
      }
      const inspect = async () =>
        GoalControlSchema.parse(
          await controller!.evaluateJson(
            `(${INSPECT_GOAL_CONTROL}).call(document.getElementById("amount"),${JSON.stringify([origin])})`,
          ),
        );
      const before = await inspect();
      assert.equal(before.fieldLabel, "Amount");
      assert.ok(before.context.some((t) => t.includes("元/月")));
      assert.ok(before.context.every((t) => !t.includes("Other category")));
      await controller.evaluateJson(
        'document.querySelector("#other option").textContent="Unrelated update"',
      );
      assert.deepEqual((await inspect()).context, before.context);
      await controller.evaluateJson('document.getElementById("units").textContent="元/年"');
      assert.notDeepEqual((await inspect()).context, before.context);
      await controller.evaluateJson('document.getElementById("amount").required=true');
      const required = await inspect();
      assert.equal(required.required, true);
      assert.equal(required.requiredSource, "html");
      assert.ok(required.validationErrors?.length);
      const activeController = controller;
      let caseNumber = 0;
      const reset = async (content: string, frameContent = "") => {
        html = content;
        frameHtml = frameContent;
        const query = "?case=" + String(++caseNumber);
        await activeController.navigate(origin + query);
        for (let i = 0; i < 80; i++) {
          if (
            await activeController.evaluateJson(
              "location.search===" + JSON.stringify(query) + " && document.readyState==='complete'",
            )
          ) {
            return;
          }
          await delay(25);
        }
        throw new Error("Observation fixture did not load");
      };
      const inspectElement = async (id: string, frameId?: string) => {
        const documentExpression = frameId
          ? "document.getElementById(" + JSON.stringify(frameId) + ").contentDocument"
          : "document";
        return GoalControlSchema.parse(
          await activeController.evaluateJson(
            "(" +
              INSPECT_GOAL_CONTROL +
              ").call(" +
              documentExpression +
              ".getElementById(" +
              JSON.stringify(id) +
              ")," +
              JSON.stringify([origin]) +
              ")",
          ),
        );
      };

      await t.test("unrelated live status never enters local field semantics", async () => {
        await reset(
          '<form><section><label for="city">城市</label><input id="city" aria-describedby="hint" aria-errormessage="error"><span id="hint" role="status">请选择所在城市</span><span id="error" role="alert"></span><small id="unit">市</small><div><output id="local-clock">10:00</output></div></section>' +
            '<section><label>Other<input id="peer"></label></section><div><span id="status" role="status">待检查</span></div><div aria-live="polite" id="global-live">等待</div><output id="global-clock">11:00</output></form>',
        );
        const initial = await inspectElement("city");
        assert.ok(initial.context.some((text) => text.includes("请选择所在城市")));
        assert.ok(initial.context.every((text) => !/待检查|10:00|11:00|等待/.test(text)));
        await activeController.evaluateJson(
          'document.getElementById("status").textContent="检查通过";document.getElementById("local-clock").textContent="10:01";document.getElementById("global-clock").textContent="11:01";document.getElementById("global-live").textContent="就绪"',
        );
        assert.deepEqual((await inspectElement("city")).context, initial.context);
        assert.equal(
          await activeController.evaluateJson('document.getElementById("status").innerText'),
          "检查通过",
        );
        assert.ok(
          JSON.stringify(await activeController.getFullAccessibilityTree()).includes("检查通过"),
        );
        assert.ok(
          String(await activeController.evaluateJson("document.body.innerText")).includes(
            "检查通过",
          ),
        );
        await activeController.evaluateJson(
          'document.getElementById("hint").textContent="请选择国内城市"',
        );
        assert.notDeepEqual((await inspectElement("city")).context, initial.context);
        await activeController.evaluateJson(
          'document.getElementById("error").textContent="城市不可用"',
        );
        assert.ok((await inspectElement("city")).validationErrors?.includes("城市不可用"));
        const beforeUnit = await inspectElement("city");
        await activeController.evaluateJson('document.getElementById("unit").textContent="省"');
        assert.notDeepEqual((await inspectElement("city")).context, beforeUnit.context);
      });

      await t.test("CSS order is measured independently of DOM and ref order", async () => {
        await reset(
          "<style>input{width:80px}.vertical{display:flex;flex-direction:column}.horizontal{display:grid;grid-template-columns:120px 120px}</style>" +
            '<form><div class="vertical"><label style="order:2">Later<input id="dom-first"></label><label style="order:1">Earlier<input id="dom-second"></label></div>' +
            '<div class="horizontal"><label style="grid-column:2;grid-row:1">Right<input id="right"></label><label style="grid-column:1;grid-row:1">Left<input id="left"></label></div></form>',
        );
        const domFirst = await inspectElement("dom-first");
        const domSecond = await inspectElement("dom-second");
        const right = await inspectElement("right");
        const left = await inspectElement("left");
        assert.ok(domFirst.position && domSecond.position && left.position && right.position);
        assert.ok(domSecond.position.top < domFirst.position.top);
        assert.ok(left.position.left < right.position.left);
        assert.ok(Math.abs(left.position.top - right.position.top) < 1);
        assert.deepEqual(
          await activeController.evaluateJson(
            '[...document.querySelectorAll("input")].map(input=>input.id)',
          ),
          ["dom-first", "dom-second", "right", "left"],
        );
      });

      await t.test(
        "iframe offsets and top-level scroll yield projected document positions",
        async () => {
          await reset(
            '<style>body{margin:0}iframe{margin-left:40px;width:480px;height:140px;border:5px solid}</style><div style="height:240px"></div><iframe id="frame-one" src="/frame"></iframe><iframe id="frame-two" src="/frame"></iframe><div style="height:1200px"></div>',
            '<style>body{margin:0}</style><section><div style="height:60px"></div><input id="inside"></section><div style="height:600px"></div>',
          );
          const first = await inspectElement("inside", "frame-one");
          const second = await inspectElement("inside", "frame-two");
          const expected = z
            .object({ top: z.number(), left: z.number() })
            .parse(
              await activeController.evaluateJson(
                '(()=>{const frame=document.getElementById("frame-one"),outer=frame.getBoundingClientRect(),inner=frame.contentDocument.getElementById("inside").getBoundingClientRect();return {top:outer.top+frame.clientTop+inner.top+scrollY,left:outer.left+frame.clientLeft+inner.left+scrollX}})()',
              ),
            );
          assert.deepEqual(first.position, expected);
          assert.ok(first.ownerPaths?.length && second.ownerPaths?.length);
          assert.ok(first.ownerPaths.every((path) => !second.ancestorPaths?.includes(path)));
          await activeController.evaluateJson("scrollTo(0,120)");
          assert.deepEqual((await inspectElement("inside", "frame-one")).position, first.position);
          await activeController.evaluateJson(
            'document.getElementById("frame-one").contentWindow.scrollTo(0,30)',
          );
          const scrolled = await inspectElement("inside", "frame-one");
          assert.ok(first.position && scrolled.position);
          assert.equal(scrolled.position.top, first.position.top - 30);
        },
      );

      await t.test(
        "required and optional labels are evidence, absent markers remain unknown",
        async () => {
          await reset(
            '<style>.required-label::before{content:"*"}</style><form>' +
              '<section><label>Unmarked<input id="unknown"></label></section>' +
              '<section><label>HTML<input id="html-required" required aria-required="false"></label></section>' +
              '<section><label>ARIA<input id="aria-required" aria-required="true"></label></section>' +
              '<section><label>ARIA optional<input id="aria-optional" aria-required="false"></label></section>' +
              '<section><label>姓名 *<input id="star"></label></section>' +
              '<section><span id="external-label">经验（必填）</span><input id="named" aria-labelledby="external-label"></section>' +
              '<section><span>* Local label</span><input id="local"></section>' +
              '<section><label class="required-label" for="pseudo">Generated marker</label><input id="pseudo"></section>' +
              '<section><label>备注（选填）<textarea id="optional"></textarea></label></section>' +
              '<section><span>奖金（可补充）</span><input id="supplement"></section>' +
              '<section><label>Optional notes<input id="english-optional"></label></section>' +
              '<section><label>Notes<textarea id="content-not-label">optional</textarea></label></section></form>',
          );
          for (const id of ["unknown", "content-not-label"]) {
            const evidence = await inspectElement(id);
            assert.equal(evidence.required, undefined, id);
            assert.equal(evidence.requiredSource, undefined, id);
          }
          assert.equal((await inspectElement("html-required")).requiredSource, "html");
          assert.equal((await inspectElement("aria-required")).requiredSource, "aria");
          assert.equal((await inspectElement("aria-optional")).required, false);
          for (const id of ["star", "named", "local", "pseudo"]) {
            const evidence = await inspectElement(id);
            assert.equal(evidence.required, true, id);
            assert.equal(evidence.requiredSource, "label-required", id);
          }
          for (const id of ["optional", "supplement", "english-optional"]) {
            const evidence = await inspectElement(id);
            assert.equal(evidence.required, false, id);
            assert.equal(evidence.requiredSource, "label-optional", id);
          }
        },
      );

      await t.test(
        "peer custom field values do not change another field's context or owner",
        async () => {
          await reset(
            "<style>[tabindex]{padding:12px;border:1px solid #888}.pair{display:flex;gap:16px}</style>" +
              '<form><section><div id="group-label">Preference group</div><div class="pair">' +
              '<div id="first-owner"><div id="first-trigger" tabindex="0" aria-errormessage="first-error"><input type="hidden"><span id="first-current">Pick tier</span></div><div id="first-menu" style="display:none"><span>Starter</span> <span id="first-option">Advanced</span></div><small id="first-error"></small></div>' +
              '<div><div id="second-trigger" tabindex="0"><input type="hidden" id="second-hidden"><span id="second-current">Pick region</span></div><div style="display:none">North South</div></div>' +
              '</div></section><button type="button">Review</button></form>',
          );
          const first = await inspectElement("first-trigger");
          const second = await inspectElement("second-trigger");
          assert.ok(first.context.includes("Preference group"));
          assert.ok(first.context.every((text) => !text.includes("Pick region")));
          assert.ok(first.ownerPaths?.length);
          assert.ok(first.ownerPaths.every((path) => !second.ancestorPaths?.includes(path)));
          await activeController.evaluateJson(
            'document.getElementById("second-current").textContent="South";document.getElementById("second-hidden").value="South"',
          );
          const peerChanged = await inspectElement("first-trigger");
          assert.deepEqual(peerChanged.context, first.context);
          assert.deepEqual(peerChanged.ownerPaths, first.ownerPaths);
          assert.deepEqual(peerChanged.validationErrors, first.validationErrors);
          await activeController.evaluateJson(
            'document.getElementById("first-menu").style.display="block"',
          );
          const open = await inspectElement("first-trigger");
          assert.ok(open.context.some((text) => text.includes("Advanced")));
          await activeController.evaluateJson(
            'document.getElementById("first-option").textContent="Premium"',
          );
          assert.notDeepEqual((await inspectElement("first-trigger")).context, open.context);
          await activeController.evaluateJson(
            'document.getElementById("first-error").textContent="Choose an available tier"',
          );
          assert.ok(
            (await inspectElement("first-trigger")).validationErrors?.includes(
              "Choose an available tier",
            ),
          );
        },
      );

      await t.test(
        "picker semantics identify fields without treating every button as a field",
        async () => {
          await reset(
            '<form><section id="scope"><label>Amount<input id="amount-field"></label><button type="button">Help</button><small>元/月</small></section>' +
              '<section><div>Preferences</div><div><div><button id="picker-one" type="button" aria-haspopup="listbox">Choose size</button></div><div><button id="picker-two" type="button" aria-haspopup="listbox">Choose color</button></div></div></section></form>',
          );
          const amount = await inspectElement("amount-field");
          assert.ok(amount.context.some((text) => text.includes("元/月")));
          const first = await inspectElement("picker-one");
          const second = await inspectElement("picker-two");
          assert.ok(first.context.includes("Preferences"));
          assert.ok(first.context.every((text) => !text.includes("Choose color")));
          assert.ok(first.ownerPaths?.every((path) => !second.ancestorPaths?.includes(path)));
          await activeController.evaluateJson(
            'document.getElementById("picker-two").textContent="Blue"',
          );
          assert.deepEqual((await inspectElement("picker-one")).context, first.context);
        },
      );

      await t.test(
        "visible custom display is separate from its stable accessible label",
        async () => {
          await reset(
            '<form><section><label id="rate-label">Daily rate</label><button id="rate-button" type="button" aria-labelledby="rate-label" aria-haspopup="dialog">Choose rate</button></section>' +
              '<section><label id="input-label">Native amount</label><input id="native-input" aria-labelledby="input-label" value="10"></section>' +
              '<section><label>Native category<select id="native-select"><option value="first">First</option><option value="second">Second</option></select></label></section></form>',
          );
          const before = await inspectElement("rate-button");
          assert.equal(before.fieldLabel, "Daily rate");
          assert.equal(before.observedName, "Daily rate");
          assert.equal(before.displayText, "Choose rate");
          assert.equal(before.observedValue, undefined);
          assert.equal(before.actionValue, "");
          await activeController.evaluateJson(
            'document.getElementById("rate-button").textContent="200元/日"',
          );
          const after = await inspectElement("rate-button");
          assert.equal(after.fieldLabel, before.fieldLabel);
          assert.equal(after.observedName, before.observedName);
          assert.equal(after.displayText, "200元/日");
          assert.equal(after.observedValue, undefined);
          const nativeInput = await inspectElement("native-input");
          const nativeSelect = await inspectElement("native-select");
          assert.equal(nativeInput.observedValue, "10");
          assert.equal(nativeInput.displayText, undefined);
          assert.equal(nativeSelect.observedValue, "first");
          assert.equal(nativeSelect.displayText, undefined);
          await activeController.evaluateJson(
            'document.querySelector("#native-select option").textContent="Revised first choice"',
          );
          assert.notDeepEqual(
            (await inspectElement("native-select")).options,
            nativeSelect.options,
          );
        },
      );

      await t.test(
        "button payload stays separate from selected display and remains observable",
        async () => {
          await reset(
            '<form><label id="rate-label">Daily rate</label><button id="token-button" type="button" value="dispatch-a" aria-labelledby="rate-label">200元/日</button>' +
              '<input id="submit-input" type="submit" value="submit-token"><output id="actual-output">25</output></form>',
          );
          const before = await inspectElement("token-button");
          assert.equal(before.fieldLabel, "Daily rate");
          assert.equal(before.displayText, "200元/日");
          assert.equal(before.observedValue, undefined);
          assert.equal(before.actionValue, "dispatch-a");
          await activeController.evaluateJson(
            'document.getElementById("token-button").value="dispatch-b"',
          );
          const after = await inspectElement("token-button");
          assert.equal(after.displayText, before.displayText);
          assert.equal(after.observedValue, undefined);
          assert.equal(after.actionValue, "dispatch-b");
          const actionInput = await inspectElement("submit-input");
          assert.equal(actionInput.observedValue, undefined);
          assert.equal(actionInput.actionValue, "submit-token");
          const output = await inspectElement("actual-output");
          assert.equal(output.observedValue, "25");
          assert.equal(output.actionValue, undefined);
        },
      );

      await t.test(
        "native constraints reflect only present attributes and detect rule changes",
        async () => {
          await reset(
            '<form><section><label>Code<input id="code" minlength="2" maxlength="8" pattern="[A-Z]+"></label></section>' +
              '<section><label>Count<input id="count" type="number" min="1" max="9" step="2"></label></section>' +
              '<section><label>Plain<input id="plain"></label></section>' +
              '<section><label>Tags<select id="tags" multiple><option>One</option><option>Two</option></select></label></section></form>',
          );
          const code = await inspectElement("code");
          const count = await inspectElement("count");
          assert.deepEqual(code.constraints, { minlength: "2", maxlength: "8", pattern: "[A-Z]+" });
          assert.deepEqual(count.constraints, { min: "1", max: "9", step: "2" });
          assert.equal((await inspectElement("plain")).constraints, undefined);
          assert.deepEqual((await inspectElement("tags")).constraints, { multiple: true });
          await activeController.evaluateJson(
            'document.getElementById("plain").value="peer update"',
          );
          const peerChanged = await inspectElement("code");
          assert.deepEqual(peerChanged.constraints, code.constraints);
          assert.deepEqual(peerChanged.context, code.context);
          await activeController.evaluateJson(
            'document.getElementById("code").setAttribute("maxlength","4");document.getElementById("code").setAttribute("pattern","[A-F]+")',
          );
          const changed = await inspectElement("code");
          assert.equal(changed.constraints?.maxlength, "4");
          assert.equal(changed.constraints?.pattern, "[A-F]+");
          assert.notDeepEqual(changed.constraints, code.constraints);
          await activeController.evaluateJson(
            'for(const key of ["minlength","maxlength","pattern"])document.getElementById("code").removeAttribute(key);document.getElementById("tags").removeAttribute("multiple")',
          );
          assert.equal((await inspectElement("code")).constraints, undefined);
          assert.equal((await inspectElement("tags")).constraints, undefined);
        },
      );

      await t.test(
        "local owner paths bind newly inserted choices without crossing another field",
        async () => {
          await reset(
            '<form><section id="city-field"><div><label for="city">City</label><div><input id="city"></div></div></section><section><label>Other<input id="unrelated"></label><button id="other-choice" type="button">Other choice</button></section></form>',
          );
          const originalHtml = await activeController.evaluateJson(
            "document.documentElement.outerHTML",
          );
          const before = await inspectElement("city");
          assert.equal(
            await activeController.evaluateJson("document.documentElement.outerHTML"),
            originalHtml,
          );
          await activeController.evaluateJson(
            'document.getElementById("city-field").insertAdjacentHTML("beforeend",\'<div><button id="city-choice" role="option" type="button">City option</button></div>\')',
          );
          const after = await inspectElement("city");
          const inline = await inspectElement("city-choice");
          const other = await inspectElement("other-choice");
          assert.deepEqual(after.ownerPaths, before.ownerPaths);
          assert.ok(before.ownerPaths?.some((path) => inline.ancestorPaths?.includes(path)));
          assert.ok(before.ownerPaths?.every((path) => !other.ancestorPaths?.includes(path)));
          assert.ok(before.ownerPaths?.every((path) => !path.endsWith("/form[1]")));
        },
      );
    } finally {
      controller?.close();
      if (chrome.exitCode === null) {
        chrome.kill("SIGTERM");
        await once(chrome, "exit");
      }
      server.close();
      await once(server, "close");
      await rm(profile, { recursive: true, force: true });
    }
  },
);
