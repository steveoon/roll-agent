import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserScriptPageDriver } from "@roll-agent/browser";
import { browserTestFixture } from "./goal/browser-test-fixture.e2e.ts";
import { ExecutionVisualFeedback } from "./execution-visual-feedback.ts";
import { NativeVisualActivitySession } from "./native-visual-activity-session.ts";
import { observeBrowserPage } from "./browser-observation.ts";
import { setVisualActivityEnabledForTests } from "./visual-activity.ts";
import { setVisualCursorEnabledForTests } from "./visual-cursor.ts";

test(
  "execution card stays outside observations and hit tests across action, navigation and cancellation",
  { skip: process.env["RUN_VISUAL_FEEDBACK_E2E"] !== "1", timeout: 60000 },
  async (t) => {
    const fixture = await browserTestFixture((path) =>
      path === "/child"
        ? "<!doctype html><html><body>Frame content</body></html>"
        : `<!doctype html><html><meta charset="utf-8"><title>Visual test</title>
        <button id="save" onclick="window.clicked=(window.clicked||0)+1">Save</button>
        <button id="editor" style="position:absolute;right:24px;top:24px" onclick="document.getElementById('title').hidden=false">编辑职位名称</button>
        <input id="title" aria-label="职位名称" hidden>
        <input id="city" aria-label="城市" style="position:absolute;right:24px;top:100px">
        <input id="private" aria-label="Private value" value="secret-value">
        <iframe src="/child"></iframe></html>`,
    );
    t.after(async () => {
      setVisualActivityEnabledForTests(undefined);
      setVisualCursorEnabledForTests(undefined);
      await fixture.close();
    });
    setVisualActivityEnabledForTests(true);
    setVisualCursorEnabledForTests(true);
    const { controller, origin, pageId } = fixture;
    await controller.navigate(`${origin}/start`);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await controller.evaluateJson<boolean>("Boolean(document.querySelector('#save'))")) break;
      await delay(50);
    }
    const visual = new ExecutionVisualFeedback(controller, "form");
    await visual.begin();
    const abort = new AbortController();
    const driver = new BrowserScriptPageDriver({
      controller,
      pageId,
      browserInstance: "test",
      allowedOrigins: [origin],
      capabilities: ["read", "interact", "navigate"],
      signal: abort.signal,
      guard: async () => {},
      observe: async () => ({}),
      resolveRef: async () => undefined,
      capture: async () => ({ id: "unused", path: "unused", mimeType: "image/png" }),
      onPointer: async (event) => await visual.pointer(event),
      onTarget: (event) => visual.focusTarget(event),
    });

    const initialObservation = await observeBrowserPage({
      controller,
      page: { targetId: pageId },
      browserInstance: "test",
      allowedOrigins: [origin],
      maxNodes: 120,
      interactiveOnly: true,
    });
    visual.observe(initialObservation, ["职位名称", "城市"]);
    await visual.invoke(driver, "click", [{ css: "#editor" }]);
    await delay(320);
    const editorState = await controller.evaluateJson<{
      card: string;
      region: DOMRect;
      target: DOMRect;
      cardRect: DOMRect;
      opacity: string;
    }>(`(() => {
      const card=document.getElementById('roll-agent-visual-execution-card');
      const region=document.getElementById('roll-agent-visual-activity-region');
      const target=document.querySelector('#editor');
      const rect=(element)=>{const r=element?.getBoundingClientRect();return r?{
        left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null};
      return { card:card?.textContent||'', region:rect(region),
        target:rect(target), cardRect:rect(card),
        opacity:region?.style.opacity||'' };
    })()`);
    assert.match(editorState.card, /打开「职位名称」编辑入口/u);
    assert.equal(editorState.opacity, "1");
    assert.ok(editorState.region.width > 0 && editorState.region.height > 0);
    assert.ok(
      Math.abs(editorState.region.left - editorState.target.left) < 4,
      JSON.stringify(editorState),
    );
    assert.ok(
      Math.abs(editorState.region.top - editorState.target.top) < 4,
      JSON.stringify(editorState),
    );
    assert.ok(
      editorState.cardRect.bottom <= editorState.target.top ||
        editorState.cardRect.top >= editorState.target.bottom ||
        editorState.cardRect.right <= editorState.target.left ||
        editorState.cardRect.left >= editorState.target.right,
    );

    const expandedObservation = await observeBrowserPage({
      controller,
      page: { targetId: pageId },
      browserInstance: "test",
      allowedOrigins: [origin],
      maxNodes: 120,
      interactiveOnly: true,
    });
    visual.observe(expandedObservation, ["职位名称", "城市"]);
    await visual.invoke(driver, "fill", [{ css: "#title" }, "private-title-value"]);
    await delay(100);
    assert.match(
      await controller.evaluateJson<string>(
        "document.getElementById('roll-agent-visual-execution-card')?.textContent||''",
      ),
      /填写「职位名称」/u,
    );
    await visual.invoke(driver, "fill", [{ css: "#city" }, "private-city-value"]);
    await delay(100);
    const cityCard = await controller.evaluateJson<string>(
      "document.getElementById('roll-agent-visual-execution-card')?.textContent||''",
    );
    assert.match(cityCard, /填写「城市」/u);
    assert.doesNotMatch(cityCard, /private-title-value|private-city-value/u);

    await visual.invoke(driver, "click", [{ css: "#save" }]);
    const pageState = await controller.evaluateJson<{
      clicked: number;
      rootHidden: boolean;
      rootInert: boolean;
      pointerEvents: string;
      hit: string;
      card: string;
      childHasCard: boolean;
    }>(`(() => {
      const button=document.querySelector('#save'), rect=button.getBoundingClientRect();
      const root=document.getElementById('roll-agent-visual-activity-root');
      return {
        clicked:window.clicked||0,
        rootHidden:root?.getAttribute('aria-hidden')==='true',
        rootInert:root?.hasAttribute('inert')||false,
        pointerEvents:root ? getComputedStyle(root).pointerEvents : '',
        hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.id||'',
        card:document.getElementById('roll-agent-visual-execution-card')?.textContent||'',
        childHasCard:Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('roll-agent-visual-execution-card'))
      };
    })()`);
    assert.equal(pageState.clicked, 1);
    assert.equal(pageState.rootHidden, true);
    assert.equal(pageState.rootInert, true);
    assert.equal(pageState.pointerEvents, "none");
    assert.equal(pageState.hit, "save");
    assert.match(pageState.card, /点击控件已执行/u);
    assert.doesNotMatch(
      pageState.card,
      /secret-value|private-title-value|private-city-value|#save|@e1/u,
    );
    assert.equal(pageState.childHasCard, false);

    const observation = await observeBrowserPage({
      controller,
      page: { targetId: pageId },
      browserInstance: "test",
      allowedOrigins: [origin],
      maxNodes: 120,
      interactiveOnly: true,
    });
    assert.doesNotMatch(JSON.stringify(observation.nodes), /浏览器任务|填写已授权表单|点击控件/u);
    if (process.env["RUN_VISUAL_FEEDBACK_CAPTURE"] === "1") {
      await writeFile(
        "/tmp/roll-browser-execution-visual-feedback.png",
        Buffer.from(await controller.captureScreenshot({ format: "png" }), "base64"),
      );
    }

    await visual.invoke(driver, "goto", [`${origin}/next`]);
    assert.equal(
      await controller.evaluateJson<boolean>(
        "Boolean(document.getElementById('roll-agent-visual-execution-card'))",
      ),
      true,
    );
    abort.abort();
    await assert.rejects(visual.invoke(driver, "click", [{ css: "#save" }]));
    await visual.finish("执行已取消 · 已发出动作未回滚", "error");
    assert.match(
      await controller.evaluateJson<string>(
        "document.getElementById('roll-agent-visual-execution-card')?.textContent||''",
      ),
      /执行已取消/u,
    );
    driver.close();
  },
);

test(
  "out-of-order visual callbacks cannot replace a newer run or resurrect a completed run",
  {
    skip: process.env["RUN_VISUAL_FEEDBACK_E2E"] !== "1",
    timeout: 60000,
  },
  async (t) => {
    const fixture = await browserTestFixture(() => "<!doctype html><button>Fixture</button>");
    t.after(async () => await fixture.close());
    setVisualActivityEnabledForTests(true);
    setVisualCursorEnabledForTests(true);
    t.after(() => {
      setVisualActivityEnabledForTests(undefined);
      setVisualCursorEnabledForTests(undefined);
    });
    await fixture.controller.navigate(`${fixture.origin}/`);
    const scripts: string[] = [];
    const visual = new NativeVisualActivitySession({
      evaluateJson: async <T>(expression: string): Promise<T> => {
        scripts.push(expression);
        return true as T;
      },
    });
    const card = (ownerId: string, epoch: number, revision: number) => ({
      ownerId,
      epoch,
      revision,
      actionRevision: 1,
      title: ownerId,
      stage: "running",
      recent: [],
    });
    await visual.showExecutionCard(card("old-A", 1, 1), "begin");
    await visual.showExecutionCard(card("new-B", 2, 1), "begin");
    await fixture.controller.evaluateJson(scripts[1]!);
    await fixture.controller.evaluateJson(scripts[0]!);
    assert.equal(
      await fixture.controller.evaluateJson<string>(
        "document.getElementById('roll-agent-visual-execution-card')?.dataset.ownerId||''",
      ),
      "new-B",
    );
    scripts.length = 0;
    await visual.showExecutionCard({ ...card("new-B", 2, 3), lingerMs: 0 }, "complete");
    await visual.showExecutionCard(card("new-B", 2, 2), "update");
    await visual.previewExecutionPointer({
      ownerId: "new-B",
      epoch: 2,
      actionRevision: 1,
      type: "mousePressed",
      x: 15,
      y: 15,
    });
    await fixture.controller.evaluateJson(scripts[0]!);
    await delay(60);
    await fixture.controller.evaluateJson(scripts[1]!);
    await fixture.controller.evaluateJson(scripts[2]!);
    assert.equal(
      await fixture.controller.evaluateJson<boolean>(
        "Boolean(document.getElementById('roll-agent-visual-execution-card'))",
      ),
      false,
    );
    assert.equal(
      await fixture.controller.evaluateJson<boolean>(
        "Boolean(document.getElementById('roll-agent-visual-cursor-root'))",
      ),
      false,
    );
    scripts.length = 0;
    await visual.showExecutionCard(card("fresh-C", 3, 1), "begin");
    await visual.clearExecutionCard({
      ownerId: "fresh-C",
      epoch: 3,
      revision: 2,
      actionRevision: 1,
    });
    await fixture.controller.evaluateJson(scripts[0]!);
    await fixture.controller.evaluateJson(scripts[1]!);
    await fixture.controller.evaluateJson(scripts[0]!);
    assert.equal(
      await fixture.controller.evaluateJson<boolean>(
        "Boolean(document.getElementById('roll-agent-visual-execution-card'))",
      ),
      false,
    );
  },
);

test(
  "execution card and cursor toggles stay independent through completion and the next run",
  { skip: process.env["RUN_VISUAL_FEEDBACK_E2E"] !== "1", timeout: 60000 },
  async (t) => {
    const fixture = await browserTestFixture(() => "<!doctype html><button>Local fixture</button>");
    t.after(async () => {
      setVisualActivityEnabledForTests(undefined);
      setVisualCursorEnabledForTests(undefined);
      await fixture.close();
    });
    const read = async () =>
      await fixture.controller.evaluateJson<{
        card: boolean;
        cursor: boolean;
        ownerId?: string;
        epoch?: number;
        terminal?: boolean;
        pointer?: string;
      }>(`(() => {
      const state=window.__rollVisualExecutionState;
      return {card:!!document.getElementById('roll-agent-visual-execution-card'),
        cursor:!!document.getElementById('roll-agent-visual-cursor-root'),
        ownerId:state?.ownerId,epoch:state?.epoch,terminal:state?.terminal,
        pointer:document.getElementById('roll-agent-visual-cursor-pointer')?.style.transform};
    })()`);

    for (const [activity, cursor] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]) {
      setVisualActivityEnabledForTests(activity);
      setVisualCursorEnabledForTests(cursor);
      await fixture.controller.navigate(
        `${fixture.origin}/combo-${Number(activity)}-${Number(cursor)}`,
      );
      const scripts: string[] = [];
      const target = {
        evaluateJson: async <T>(
          expression: string,
          options?: { timeoutMs?: number },
        ): Promise<T> => {
          scripts.push(expression);
          return await fixture.controller.evaluateJson<T>(expression, options);
        },
      };
      const first = new ExecutionVisualFeedback(target, "script");
      await first.begin();
      first.pointer({ type: "mouseMoved", x: 10, y: 20 });
      await delay(50);
      const active = await read();
      assert.equal(active.card, activity, `activity=${activity}, cursor=${cursor}`);
      assert.equal(active.cursor, cursor, `activity=${activity}, cursor=${cursor}`);
      const oldPointerScript = scripts.find((script) => script.includes('"cursor":'));
      await first.finish("结束", "info");
      const finished = await read();
      if (activity || cursor) assert.equal(finished.terminal, true);
      else assert.equal(finished.ownerId, undefined);

      if (cursor && oldPointerScript) {
        await delay(750);
        assert.equal((await read()).cursor, false);
        await fixture.controller.evaluateJson(oldPointerScript);
        assert.equal((await read()).cursor, false, "terminal execution rejected a late cursor");
      }

      const second = new ExecutionVisualFeedback(target, "script");
      await second.begin();
      second.pointer({ type: "mouseMoved", x: 40, y: 50 });
      await delay(50);
      const next = await read();
      assert.equal(next.card, activity);
      assert.equal(next.cursor, cursor);
      if (activity || cursor) {
        assert.equal(next.terminal, false);
        assert.ok(next.epoch! > finished.epoch!);
        assert.notEqual(next.ownerId, finished.ownerId);
      }
      if (cursor && oldPointerScript) {
        assert.equal(next.pointer, "translate(38px, 48px)");
        await fixture.controller.evaluateJson(oldPointerScript);
        assert.equal((await read()).pointer, next.pointer, "older run cannot move newer cursor");
      }
      await second.finish("结束", "info");
    }

    setVisualActivityEnabledForTests(true);
    setVisualCursorEnabledForTests(true);
    await fixture.controller.navigate(`${fixture.origin}/toggle-during-run`);
    const scripts: string[] = [];
    const changing = new ExecutionVisualFeedback(
      {
        evaluateJson: async <T>(
          expression: string,
          options?: { timeoutMs?: number },
        ): Promise<T> => {
          scripts.push(expression);
          return await fixture.controller.evaluateJson<T>(expression, options);
        },
      },
      "script",
    );
    await changing.begin();
    changing.pointer({ type: "mouseMoved", x: 12, y: 22 });
    await delay(50);
    const oldPointer = scripts.find((script) => script.includes('"cursor":'));
    assert.ok(oldPointer);
    setVisualActivityEnabledForTests(false);
    setVisualCursorEnabledForTests(false);
    changing.setStage("checking");
    await changing.finish("结束", "info");
    assert.equal((await read()).terminal, true);
    assert.equal((await read()).card, false);
    await delay(750);
    await fixture.controller.evaluateJson(oldPointer);
    assert.equal(
      (await read()).cursor,
      false,
      "late callback stays rejected after toggles turn off",
    );
  },
);
