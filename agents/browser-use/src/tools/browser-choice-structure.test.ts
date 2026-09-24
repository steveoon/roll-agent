import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DOM_CHOICE_UTILS,
  NativeCdpController,
  createBrowserAxSnapshot,
} from "@roll-agent/browser";
import { READ_GOAL_TEXT } from "../goal/task-observation.ts";
import { GoalPageStateSchema } from "../goal/observation.ts";
import { BrowserOperateInputSchema } from "../goal/contracts.ts";
import { buildTaskDecisionRequest } from "../goal/task-policy.ts";
import { collectDomActionHints } from "./browser-dom-action-candidates.ts";

// Opt-in real DOM test: never attaches to a user's profile or authenticated page.
test(
  "choice segmentation executes the real collector in isolated Chrome",
  {
    skip: process.env["RUN_BROWSER_CHOICE_E2E"] !== "1",
    timeout: 30_000,
  },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), "roll-choice-dom-"));
    const chrome = spawn(
      process.env["CHROME_EXECUTABLE"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    let controller: NativeCdpController | undefined;
    let spawnError: Error | undefined;
    chrome.on("error", (error) => {
      spawnError = error;
    });
    try {
      let port = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (spawnError) throw spawnError;
        port =
          (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split(
            "\n",
          )[0] ?? "";
        if (port) break;
        await delay(100);
      }
      assert.ok(port, "isolated Chrome debug endpoint started");
      const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      assert.ok(Array.isArray(targets));
      const target: unknown = targets.find(
        (entry: unknown) =>
          typeof entry === "object" && entry !== null && "type" in entry && entry.type === "page",
      );
      assert.ok(
        typeof target === "object" &&
          target !== null &&
          "webSocketDebuggerUrl" in target &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      const browser = await NativeCdpController.connect({
        webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      });
      controller = browser;
      const hints = async (html: string) => {
        await browser.evaluateJson(`document.body.innerHTML = ${JSON.stringify(html)}; true`);
        return await collectDomActionHints(browser);
      };
      await t.test("short and long delegated lists preserve the same row granularity", async () => {
        for (const labels of [
          ["Any", "Junior", "Senior"],
          Array.from({ length: 59 }, (_, i) => `Level ${i}`),
        ]) {
          const found = await hints(
            `<div class="dropdown" style="cursor:pointer"><span>Choose experience</span><ul>${labels.map((label) => `<li><i aria-hidden="true">•</i><span>${label}</span></li>`).join("")}</ul></div>`,
          );
          assert.deepEqual(
            found.map((item) => item.name),
            ["Choose experience", ...labels],
          );
          assert.equal(new Set(found.map((item) => item.backendNodeId)).size, found.length);
        }
      });
      await t.test(
        "semantic option rows retain composite labels and disabled ancestors",
        async () => {
          const found = await hints(
            '<div role="listbox" aria-disabled="true"><div role="option"><span>Alpha</span><small>First choice</small></div><div role="option">Beta</div></div>',
          );
          assert.deepEqual(
            found.map((item) => item.name),
            ["Alpha First choice", "Beta"],
          );
          assert.ok(found.every((item) => item.disabled));
          const snapshot = await createBrowserAxSnapshot(browser, { domActionHints: found });
          assert.equal(snapshot.refs.filter((ref) => ref.role === "option").length, 2);
        },
      );
      await t.test(
        "plain prose and inherited-pointer card children are not choice groups",
        async () => {
          const found = await hints(
            '<article><p>First paragraph</p><p>Second paragraph</p><ul><li>Bullet one</li><li>Bullet two</li></ul></article><div id="card" onclick="void 0" style="cursor:pointer"><div>Product name</div><div>Product description</div></div>',
          );
          assert.equal(found.length, 1);
          assert.deepEqual(
            await browser.evaluateJson(
              `(() => { const api = (${DOM_CHOICE_UTILS})(document); return api.rows(document.querySelector('article ul')).map(api.text); })()`,
            ),
            [],
          );
          assert.match(found[0]?.name ?? "", /Product name.*Product description/);
        },
      );
      await t.test(
        "class-free repeated independently actionable siblings remain atomic",
        async () => {
          const found = await hints(
            '<section><div tabindex="0"><span>Choice one</span><i>+</i></div><div tabindex="0"><span>Choice two</span><i>+</i></div></section>',
          );
          assert.deepEqual(
            found.map((item) => item.name),
            ["Choice one +", "Choice two +"],
          );
        },
      );
      await t.test("hidden duplicate lists are absent", async () => {
        const found = await hints(
          '<ul style="cursor:pointer;display:none"><li>Same</li><li>Hidden</li></ul><ul style="cursor:pointer"><li>Same</li><li>Visible</li></ul>',
        );
        assert.deepEqual(
          found.map((item) => item.name),
          ["Same", "Visible"],
        );
      });
      await t.test(
        "native select options remain readable without DOM popup hit boxes",
        async () => {
          await hints(
            '<select id="native"><option>Any</option><optgroup label="Other"><option disabled>Disabled</option><option hidden>Hidden</option></optgroup></select>',
          );
          const found = await browser.evaluateJson(
            `(() => { const api = (${DOM_CHOICE_UTILS})(document); return api.rows(document.querySelector('#native')).map(api.text); })()`,
          );
          assert.deepEqual(found, ["Any", "Disabled"]);
        },
      );
      await t.test("scope excludes unrelated options and preserves candidate budget", async () => {
        await hints(
          '<ul style="cursor:pointer"><li>Outside A</li><li>Outside B</li></ul><ul id="inside" style="cursor:pointer"><li>Inside A</li><li>Inside B</li></ul>',
        );
        const found = await collectDomActionHints(browser, { scope: "#inside", maxCandidates: 1 });
        assert.deepEqual(
          found.map((item) => item.name),
          ["Inside A"],
        );
      });
      await t.test("nested semantic rows do not merge child labels into their parent", async () => {
        await hints(
          '<div role="tree" id="tree"><div role="treeitem"><span>Parent</span><div role="group"><div role="treeitem">Child</div></div></div><div role="treeitem">Sibling</div></div>',
        );
        const found = await browser.evaluateJson(
          `(() => { const api = (${DOM_CHOICE_UTILS})(document); return api.rows(document.querySelector('#tree')).map(api.text); })()`,
        );
        assert.deepEqual(found, ["Parent", "Sibling"]);
      });
      await t.test(
        "independent card title and icon actions survive a clickable container",
        async () => {
          const found = await hints(
            `<div class="card" style="cursor:pointer"><div class="job-title">Operations</div><span>Salary 7–8K</span><div class="more-operate" style="width:24px;height:24px"></div><button>Edit</button><button>Open</button></div>`,
          );
          assert.ok(found.some((item) => item.name === "Operations"));
          assert.ok(found.some((item) => /more-operate/.test(item.name)));
          assert.ok(!found.some((item) => item.name === "Salary 7–8K"));
        },
      );
      await t.test(
        "unnamed close controls retain DOM evidence without inventing a visible label",
        async () => {
          const found = await hints(
            `<div class="dialog" style="position:fixed;inset:20px"><h2>Notice</h2><div class="popup-close" style="cursor:pointer;width:24px;height:24px"><i class="icon-close"></i></div></div>`,
          );
          assert.equal(found.filter((item) => /popup-close/.test(item.name)).length, 1);
          assert.ok(found.some((item) => /Unlabelled/.test(item.name)));
        },
      );
      await t.test(
        "page panel and selected tab survive absence of actionable panel controls",
        async () => {
          await hints(
            `<div class="tab-item active">Closed</div><p>No results</p><div class="popup" style="position:fixed;inset:30px;background:white"><h2>Notice</h2><p>Read-only notice without controls</p></div><div role="dialog" style="display:none">Hidden</div>`,
          );
          const state = GoalPageStateSchema.parse(
            await browser.evaluateJson(
              `(${READ_GOAL_TEXT}).call(document, ["null"], 6000).pageState`,
            ),
          );
          assert.deepEqual(state.panels, ["Notice"]);
          assert.deepEqual(state.selectedTabs, ["Closed"]);
          assert.equal(state.busy, false);
        },
      );
      await t.test(
        "blocked card actions do not remove an independent read-only title",
        async () => {
          const found = await hints(
            `<div class="card" style="cursor:pointer"><div class="record-title">Operations</div><button>Edit</button><button>Open</button></div>`,
          );
          const snapshot = await createBrowserAxSnapshot(browser, { domActionHints: found });
          const request = buildTaskDecisionRequest(
            BrowserOperateInputSchema.parse({
              pageId: "test",
              goal: "Read Operations details",
              allowedOrigins: ["https://example.com"],
              blockedNames: ["Edit", "Open"],
            }),
            snapshot,
            [],
          );
          const actions = Object.values(request.questions.operation!.criteria);
          assert.ok(actions.some((label) => /Operations/.test(label) && !/Edit|Open/.test(label)));
          assert.ok(!actions.some((label) => /^CLICK.*(?:Edit|Open)/.test(label)));
        },
      );
      await t.test("collection removes temporary markers", async () => {
        const markers = await browser.evaluateJson(
          "Array.from(document.querySelectorAll('*')).flatMap(el => el.getAttributeNames()).filter(name => name.startsWith('data-roll-browser-action-'))",
        );
        assert.deepEqual(markers, []);
      });
    } finally {
      controller?.close();
      chrome.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (chrome.pid === undefined || chrome.exitCode !== null || chrome.signalCode !== null) {
          resolve();
        } else chrome.once("exit", () => resolve());
      });
      await rm(profile, { recursive: true, force: true });
    }
  },
);
