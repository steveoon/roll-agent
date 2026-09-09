import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { NativeCdpController } from "../runtime/native-cdp-controller.ts";
import { BrowserScriptPageDriver } from "./native-driver.ts";
import { BrowserExecuteInputSchema } from "./contracts.ts";
import { executeBrowserProgram } from "./execution.ts";

const custom = (
  options: {
    portal?: boolean;
    linked?: boolean;
    noChange?: boolean;
    duplicate?: boolean;
    duplicateId?: boolean;
    delay?: number;
    multi?: boolean;
  } = {},
) => `
<style>body{font:16px sans-serif;padding:30px}button,li{padding:12px}ul{cursor:pointer}li{list-style:none}small{margin-left:5px}</style>
<section id="field"><button id="trigger" ${options.linked ? 'aria-controls="menu"' : ""}>Choose</button>
${!options.portal ? '<ul id="menu" hidden><li><span>One</span><i aria-hidden="true">★</i></li><li>Two</li></ul>' : ""}</section>
${options.portal ? '<ul id="menu" role="listbox" hidden ' + (options.multi ? 'aria-multiselectable="true"' : "") + '><li role="option">One</li><li role="option">Two</li></ul>' : ""}
${options.duplicateId ? '<ul id="menu" style="cursor:pointer"><li>One</li><li>Other</li></ul>' : ""}
<ul hidden style="cursor:pointer"><li>One</li><li>Hidden duplicate</li></ul><output id="clicks">0</output>
<script>
const trigger=document.querySelector('#trigger'),menu=document.querySelector('#menu');
${options.duplicate ? "menu.lastElementChild.textContent='One';" : ""}
trigger.onclick=()=>setTimeout(()=>menu.hidden=!menu.hidden,${options.delay ?? 0});
menu.onclick=event=>{const row=event.target.closest('li');if(!row)return;document.querySelector('#clicks').textContent=String(Number(document.querySelector('#clicks').textContent)+1);${options.noChange ? "" : "trigger.textContent=row.textContent.replace('★','').trim();menu.hidden=true;"}};
</script>`;

test(
  "generic control helpers run against real DOM and native input",
  {
    skip: process.env["RUN_BROWSER_CHOICE_E2E"] !== "1",
    timeout: 60_000,
  },
  async (t) => {
    let html = "";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(request.url?.startsWith("/frame") ? custom() : html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), "roll-control-e2e-"));
    const context = await chromium.launchPersistentContext(profile, {
      executablePath:
        process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    try {
      const page = context.pages()[0]!;
      const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      let seq = 0;
      const reset = async (content: string) => {
        html = content;
        await page.goto(origin + "/?case=" + seq++);
      };
      const program = async (source: string, signal?: AbortSignal) => {
        const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        assert.ok(Array.isArray(targets));
        const target: unknown = targets.find(
          (p: unknown) => typeof p === "object" && p !== null && "type" in p && p.type === "page",
        );
        assert.ok(
          typeof target === "object" &&
            target !== null &&
            "id" in target &&
            typeof target.id === "string" &&
            "webSocketDebuggerUrl" in target &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        const controller = await NativeCdpController.connect({
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        });
        const driver = new BrowserScriptPageDriver({
          controller,
          pageId: target.id,
          browserInstance: "fixture",
          allowedOrigins: [origin],
          capabilities: ["read", "interact"],
          ...(signal ? { signal } : {}),
          guard: async () => {},
          observe: async () => ({}),
          resolveRef: async () => undefined,
          capture: async () => {
            throw new Error("No capture expected");
          },
        });
        try {
          return await executeBrowserProgram(
            BrowserExecuteInputSchema.parse({
              pageId: target.id,
              source,
              allowedOrigins: [origin],
              capabilities: ["read", "interact"],
            }),
            { driver, ...(signal ? { signal } : {}) },
          );
        } finally {
          controller.close();
        }
      };
      await t.test("native SELECT chooses exact label even when values repeat", async () => {
        await reset(
          '<label>Level<select id="native"><option value="x">One</option><option value="x">Two</option></select></label>',
        );
        const r = await program('await page.choose(page.locator("#native"),{label:"Two"});');
        assert.equal(r.status, "completed", JSON.stringify(r));
        assert.equal(r.verification, "passed");
        assert.equal(
          await page.locator("#native").evaluate((el) => (el as HTMLSelectElement).selectedIndex),
          1,
        );
      });
      await t.test("native select inside a container binds the real SELECT", async () => {
        await reset(
          '<section id="field" style="margin-top:1800px"><select><option value="a">One</option><option value="b">Two</option></select></section>',
        );
        const r = await program('return await page.choose(page.locator("#field"),{value:"b"});');
        assert.equal(r.status, "completed", JSON.stringify(r));
        assert.equal(await page.locator("select").inputValue(), "b");
      });
      await t.test(
        "class-free contained list with delegated composite rows and hidden duplicates",
        async () => {
          await reset(custom());
          const r = await program(
            'return await page.choose(page.locator("#field"),{label:"One"});',
          );
          assert.equal(r.status, "completed", JSON.stringify(r));
          assert.equal(r.verification, "passed");
          assert.equal(await page.locator("#trigger").textContent(), "One");
          assert.equal(await page.locator("#clicks").textContent(), "1");
        },
      );
      await t.test("ARIA portal relation works with delayed rendering", async () => {
        await reset(custom({ portal: true, linked: true, delay: 100 }));
        const r = await program(
          'return await page.choose(page.locator("#trigger"),{label:"Two"});',
        );
        assert.equal(r.status, "completed", JSON.stringify(r));
        assert.equal(r.verification, "passed");
      });
      await t.test("unlinked portal requires explicit region rather than guessing", async () => {
        await reset(custom({ portal: true }));
        const r = await program(
          'return await page.choose(page.locator("#trigger"),{label:"One",timeoutMs:250});',
        );
        assert.equal(r.status, "failed");
        assert.equal(r.error?.code, "control_unassociated");
        assert.equal(await page.locator("#clicks").textContent(), "0");
        const explicit = await program(
          'return await page.choose(page.locator("#trigger"),{label:"One",panel:"#menu"});',
        );
        assert.equal(explicit.status, "completed", JSON.stringify(explicit));
      });
      await t.test(
        "duplicate linked DOM IDs reject association before opening or choosing",
        async () => {
          await reset(custom({ portal: true, linked: true, duplicateId: true }));
          const r = await program(
            'return await page.choose(page.locator("#trigger"),{label:"One"});',
          );
          assert.equal(r.status, "failed");
          assert.equal(r.error?.code, "ambiguous_target");
          assert.equal(await page.locator("#clicks").textContent(), "0");
        },
      );
      await t.test("duplicate labels stop without any option click", async () => {
        await reset(custom({ duplicate: true }));
        const r = await program('return await page.choose(page.locator("#field"),{label:"One"});');
        assert.equal(r.status, "failed");
        assert.equal(r.error?.code, "ambiguous_target");
        assert.equal(await page.locator("#clicks").textContent(), "0");
      });
      await t.test("click without a selected state is never reported verified", async () => {
        await reset(custom({ noChange: true }));
        const r = await program(
          'return await page.choose(page.locator("#field"),{label:"One",timeoutMs:350});',
        );
        assert.equal(r.status, "failed");
        assert.equal(r.verification, "failed");
        assert.equal(await page.locator("#trigger").textContent(), "Choose");
        assert.equal(await page.locator("#clicks").textContent(), "1");
      });
      await t.test("ARIA multi-select is rejected before any option click", async () => {
        await reset(custom({ portal: true, linked: true, multi: true }));
        const r = await program('await page.choose(page.locator("#trigger"),{label:"One"});');
        assert.equal(r.status, "failed");
        assert.equal(r.error?.code, "unsupported_control");
        assert.equal(await page.locator("#clicks").textContent(), "0");
      });
      await t.test(
        "wrong label sharing a value and unrelated hidden input are not verification",
        async () => {
          await reset(
            custom({ noChange: true }) +
              '<input type="hidden" value="same"><script>menu.children[0].setAttribute("value","same");menu.children[1].setAttribute("value","same");menu.onclick=()=>{trigger.textContent="Two";menu.children[1].setAttribute("aria-selected","true");};</script>',
          );
          const r = await program(
            'await page.choose(page.locator("#field"),{label:"One",timeoutMs:350});',
          );
          assert.equal(r.status, "failed");
          assert.equal(r.verification, "failed");
          assert.equal(await page.locator("#trigger").textContent(), "Two");
        },
      );
      await t.test("row replacement on hover stops before pressing the replacement", async () => {
        await reset(
          custom() +
            "<script>menu.firstElementChild.onmousemove=()=>{const row=menu.firstElementChild;row.replaceWith(row.cloneNode(true));};</script>",
        );
        const r = await program('await page.choose(page.locator("#field"),{label:"One"});');
        assert.equal(r.status, "failed");
        assert.equal(r.error?.code, "stale_target");
        assert.equal(await page.locator("#clicks").textContent(), "0");
      });
      await t.test("explicit per-level expectations support a two-level cascader", async () => {
        await reset(
          '<style>li{padding:10px;cursor:pointer}button{padding:10px}</style><section id="field"><button id="trigger" aria-controls="parent">Choose</button></section><ul id="parent" hidden><li>Group</li><li>Other</li></ul><ul id="child" hidden><li>Leaf</li><li>Else</li></ul><script>trigger.onclick=()=>parent.hidden=false;</script>'.replace(
            "parent.hidden",
            'document.querySelector("#parent").hidden',
          ) +
            '<script>document.querySelector("#parent").onclick=()=>document.querySelector("#child").hidden=false;document.querySelector("#child").onclick=event=>{trigger.textContent=event.target.textContent;document.querySelector("#parent").hidden=true;document.querySelector("#child").hidden=true;};</script>',
        );
        const r = await program(
          'await page.choose(page.locator("#trigger"),{label:"Group",panel:"#parent",expect:{target:page.locator("#child"),state:"visible"}}); await page.choose(page.locator("#trigger"),{label:"Leaf",panel:"#child"});',
        );
        assert.equal(r.status, "completed", JSON.stringify(r));
        assert.equal(r.verification, "passed");
        assert.equal(await page.locator("#trigger").textContent(), "Leaf");
      });
      await t.test("pre-cancelled selection cannot perform side effects", async () => {
        await reset(custom());
        const abort = new AbortController();
        abort.abort();
        const r = await program(
          'await page.choose(page.locator("#field"),{label:"One"});',
          abort.signal,
        );
        assert.equal(r.status, "cancelled");
        assert.equal(await page.locator("#clicks").textContent(), "0");
      });
      await t.test("a root overlay blocks a child frame before native mouse input", async () => {
        await reset(
          '<iframe src="/frame" style="width:700px;height:500px"></iframe><div style="position:fixed;inset:0;background:#fff;z-index:99"></div>',
        );
        const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        assert.ok(Array.isArray(targets));
        const target = targets[0] as { webSocketDebuggerUrl: string };
        const c = await NativeCdpController.connect({
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        });
        let frameId: string | undefined;
        try {
          frameId = (await c.getFrameTree()).childFrames?.[0]?.frame.id;
        } finally {
          c.close();
        }
        assert.ok(frameId);
        const r = await program(
          `await page.choose(page.locator('#field',{frameId:${JSON.stringify(frameId)}}),{label:'One'});`,
        );
        assert.equal(r.status, "failed");
        assert.equal(r.error?.code, "target_obscured");
        assert.equal(await page.frames()[1]!.locator("#clicks").textContent(), "0");
      });
    } finally {
      await context.close();
      server.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
