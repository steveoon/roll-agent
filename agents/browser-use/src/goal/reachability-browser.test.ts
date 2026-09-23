import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { observeBrowserPage } from "../browser-observation.ts";
import { permittedFrames } from "./host.ts";
import { browserTestFixture } from "./browser-test-fixture.e2e.ts";
import { INSPECT_GOAL_CONTROL, GoalControlSchema } from "./observation.ts";

const inner = `<!doctype html><style>body{margin:0}button{display:block;width:150px;height:40px}#target{margin-top:1200px}</style><button id="anchor">Anchor</button><button id="target">Target</button>`;

test(
  "scroll evidence includes a textarea's own wheel-consuming container before its ancestors",
  {
    skip: process.env["RUN_REACHABILITY_E2E"] !== "1",
    timeout: 30000,
  },
  async () => {
    const f = await browserTestFixture(
      () =>
        `<!doctype html><div style="height:500px;overflow:auto"><textarea id="text" style="height:80px;overflow:auto">${"line\n".repeat(100)}</textarea><button id="anchor">Anchor</button><div style="height:1600px"></div></div>`,
    );
    try {
      await f.controller.navigate(f.origin);
      for (let i = 0; i < 80; i++) {
        if (await f.controller.evaluateJson('Boolean(document.getElementById("text"))')) break;
        await delay(25);
      }
      const inspect = async (id: string) =>
        GoalControlSchema.parse(
          await f.controller.evaluateJson(
            `(${INSPECT_GOAL_CONTROL}).call(document.getElementById(${JSON.stringify(id)}),${JSON.stringify([f.origin])})`,
          ),
        );
      const text = await inspect("text");
      const anchor = await inspect("anchor");
      assert.match(text.scrollContainerPaths![0]!, /textarea\[1\]$/);
      assert.equal(text.scrollContainerPaths![1], anchor.scrollContainerPaths![0]);
    } finally {
      await f.close();
    }
  },
);

test(
  "reachability proves scroll routes through frame clipping without authorizing overlays",
  {
    skip: process.env["RUN_REACHABILITY_E2E"] !== "1",
    timeout: 60000,
  },
  async (t) => {
    const f = await browserTestFixture((path) =>
      path.startsWith("/frame")
        ? inner
        : `<!doctype html><style>body{margin:0}iframe{border:0;width:900px;height:1800px}#container{height:600px;overflow:auto}</style><div id="container"><iframe src="/frame"></iframe></div>`,
    );
    const c = f.controller;
    try {
      await c.navigate(f.origin);
      for (let i = 0; i < 80; i++) {
        if (
          await c.evaluateJson(
            "Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('target'))",
          )
        ) {
          break;
        }
        await delay(25);
      }
      const inspect = async (extra = "", id = "target") =>
        GoalControlSchema.parse(
          await c.evaluateJson(
            `(()=>{const d=document.querySelector('iframe').contentDocument;${extra};return (${INSPECT_GOAL_CONTROL}).call(d.getElementById(${JSON.stringify(id)}),${JSON.stringify([f.origin])});})()`,
          ),
        );
      const revealNative = async () => {
        const snapshot = await observeBrowserPage({
          controller: c,
          page: { targetId: f.pageId },
          browserInstance: "reachability",
          allowedOrigins: [f.origin],
          allowedFrameIds: permittedFrames(await c.getFrameTree(), [f.origin]),
          maxNodes: 100,
          interactiveOnly: true,
        });
        const target = snapshot.refs.find((ref) => ref.name === "Target");
        assert.ok(target?.backendNodeId);
        await c.scrollIntoViewByBackendNodeId({ backendNodeId: target.backendNodeId });
        return inspect();
      };
      await t.test(
        "parent overflow:auto clipping is revealable and shares its actual scroll container",
        async () => {
          const target = await inspect();
          const anchor = await inspect("", "anchor");
          assert.equal(target.availability, "offscreen");
          assert.equal(target.revealViaScroll, undefined);
          assert.equal(anchor.availability, "ready");
          assert.ok(target.scrollContainerPaths?.includes("/html[1]/body[1]/div[1]"));
          assert.deepEqual(target.scrollContainerPaths, anchor.scrollContainerPaths);
          const revealed = await revealNative();
          assert.equal(revealed.availability, "ready");
        },
      );
      await t.test("overflow:hidden and an opaque modal remain covered", async () => {
        assert.equal(
          (
            await inspect(
              "document.getElementById('container').scrollTop=0;document.getElementById('container').style.overflow='hidden'",
            )
          ).availability,
          "covered",
        );
        assert.equal(
          (
            await inspect(
              "document.getElementById('container').style.overflow='auto';const cover=document.createElement('div');cover.id='cover';cover.setAttribute('aria-modal','true');cover.style='position:fixed;inset:0;background:white;z-index:99';document.body.append(cover)",
            )
          ).availability,
          "covered",
        );
        await c.evaluateJson("document.getElementById('cover').remove()");
      });
      await t.test(
        "a partial modal also keeps background targets unavailable for reveal",
        async () => {
          assert.equal(
            (
              await inspect(
                "const cover=document.createElement('div');cover.id='cover';cover.setAttribute('aria-modal','true');cover.style='position:fixed;top:10px;left:10px;width:100px;height:100px;background:white;z-index:99';document.body.append(cover)",
              )
            ).availability,
            "covered",
          );
          await c.evaluateJson("document.getElementById('cover').remove()");
        },
      );
      await t.test("a transformed frame is unavailable", async () => {
        assert.equal(
          (await inspect("document.querySelector('iframe').style.transform='scale(0.9)'"))
            .availability,
          "unavailable",
        );
        await c.evaluateJson("document.querySelector('iframe').style.transform='none'");
      });
      await t.test(
        "top viewport clips a tall frame but document scrolling can expose it",
        async () => {
          assert.equal(
            (
              await inspect(
                "document.getElementById('container').style.height='auto';document.getElementById('container').style.overflow='visible';window.scrollTo(0,0)",
              )
            ).availability,
            "offscreen",
          );
          assert.equal((await revealNative()).availability, "ready");
        },
      );
      await t.test(
        "a small fixed bottom toolbar permits a proven scroll route; central overlay does not",
        async () => {
          assert.equal(
            (
              await inspect(
                "window.scrollTo(0,1220-innerHeight+50);const footer=document.createElement('div');footer.id='footer';footer.style='position:fixed;bottom:0;left:0;right:0;height:100px;background:white;z-index:99';document.body.append(footer)",
              )
            ).availability,
            "offscreen",
          );
          // CDP's visibility reveal does not account for an edge toolbar.
          assert.equal((await revealNative()).availability, "offscreen");
          assert.equal((await inspect()).revealViaScroll, true);
          await c.dispatchMouseEvent({
            type: "mouseWheel",
            x: 400,
            y: 400,
            deltaX: 0,
            deltaY: 300,
          });
          for (let i = 0; i < 20 && (await inspect()).availability !== "ready"; i++) {
            await delay(25);
          }
          assert.equal((await inspect()).availability, "ready");
          assert.equal(
            (
              await inspect(
                "const footer=document.getElementById('footer');footer.style.top='20%';footer.style.bottom='20%';footer.style.height='auto'",
              )
            ).availability,
            "covered",
          );
        },
      );
      await t.test("DOM from an unpermitted origin is unavailable", async () => {
        const probe = await c.evaluateJson(
          `(${INSPECT_GOAL_CONTROL}).call(document.querySelector('iframe').contentDocument.getElementById('target'),[])`,
        );
        assert.equal(GoalControlSchema.parse(probe).availability, "unavailable");
      });
    } finally {
      await f.close();
    }
  },
);

test(
  "nested scrolling reveals a deeply clipped control with native CDP",
  {
    skip: process.env["RUN_REACHABILITY_E2E"] !== "1",
    timeout: 30000,
  },
  async () => {
    const f = await browserTestFixture(
      () =>
        `<!doctype html><style>body{margin:0}#outer{margin-top:1100px;height:200px;width:400px;overflow:auto}#spacer{height:700px}#inner{height:150px;overflow:auto}button{margin-top:500px;height:40px}#tail{height:500px}</style><div id="outer"><div id="spacer"></div><div id="inner"><button>Deep target</button></div><div id="tail"></div></div><div id="tail"></div>`,
    );
    try {
      const c = f.controller;
      await c.navigate(f.origin);
      const inspect = async () =>
        GoalControlSchema.parse(
          await c.evaluateJson(
            `(${INSPECT_GOAL_CONTROL}).call(document.querySelector('button'),${JSON.stringify([f.origin])})`,
          ),
        );
      const before = await inspect();
      assert.equal(before.availability, "offscreen");
      assert.equal(before.scrollContainerPaths?.length, 3);
      const raw = await observeBrowserPage({
        controller: c,
        page: { targetId: f.pageId },
        browserInstance: "nested-reachability",
        allowedOrigins: [f.origin],
        allowedFrameIds: permittedFrames(await c.getFrameTree(), [f.origin]),
        maxNodes: 50,
        interactiveOnly: true,
      });
      const target = raw.refs.find((ref) => ref.name === "Deep target");
      assert.ok(target?.backendNodeId);
      await c.scrollIntoViewByBackendNodeId({ backendNodeId: target.backendNodeId });
      assert.equal((await inspect()).availability, "ready");
    } finally {
      await f.close();
    }
  },
);
