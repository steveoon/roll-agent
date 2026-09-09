import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { assertFramePointUnoccluded, INSPECT_FRAME_ANCESTORS } from "./frame-occlusion.ts";
import type { NativeCdpFrameTree } from "../runtime/native-cdp-controller.ts";

const origin = "https://example.com";
const tree: NativeCdpFrameTree = {
  frame: { id: "main", url: origin },
  childFrames: [{ frame: { id: "child", url: `${origin}/frame` } }],
};

function fixture(result: unknown = "clear") {
  const calls: string[] = [];
  return {
    calls,
    controller: {
      getDocument: async () => {
        calls.push("document");
        return {
          root: { children: [{ frameId: "child", contentDocument: { backendNodeId: 5 } }] },
        };
      },
      resolveBackendNode: async ({ backendNodeId }: { backendNodeId: number }) => {
        assert.equal(backendNodeId, 5);
        calls.push("resolve");
        return "doc";
      },
      callFunctionOnObject: async () => {
        calls.push("inspect");
        return result;
      },
      releaseObject: async () => {
        calls.push("release");
      },
    },
    input: {
      tree,
      frameId: "child",
      point: { x: 100, y: 100 },
      allowedOrigins: [origin],
      guard: async () => {
        calls.push("guard");
      },
    },
  };
}

test("frame point guards every asynchronous inspection boundary and releases document", async () => {
  const f = fixture();
  await assertFramePointUnoccluded(f.controller, f.input);
  assert.deepEqual(f.calls, [
    "guard",
    "document",
    "guard",
    "resolve",
    "guard",
    "inspect",
    "guard",
    "release",
    "guard",
  ]);
});

test("main viewport delegates target hit testing without collecting the DOM", async () => {
  const f = fixture();
  await assertFramePointUnoccluded(f.controller, { ...f.input, frameId: "main" });
  assert.deepEqual(f.calls, ["guard"]);
});

test("parent overlay, invalid results and inaccessible frames fail closed", async () => {
  for (const [result, code] of [
    ["target_obscured", "target_obscured"],
    ["focus_changed", "focus_changed"],
    ["coverage_gap", "coverage_gap"],
    [{ clear: true }, "coverage_gap"],
  ]) {
    const f = fixture(result);
    await assert.rejects(assertFramePointUnoccluded(f.controller, f.input), { code });
    assert.equal(f.calls.at(-1), "release");
  }
  const f = fixture();
  f.controller.getDocument = async () => ({ root: { children: [] } });
  await assert.rejects(assertFramePointUnoccluded(f.controller, f.input), { code: "coverage_gap" });
});

test("cross-origin ancestor stays unsupported even if both origins are allowed", async () => {
  const f = fixture();
  await assert.rejects(
    assertFramePointUnoccluded(f.controller, {
      ...f.input,
      allowedOrigins: [origin, "https://other.example"],
      tree: {
        frame: tree.frame,
        childFrames: [{ frame: { id: "child", url: "https://other.example" } }],
      },
    }),
    { code: "coverage_gap" },
  );
  assert.deepEqual(f.calls, ["guard"]);
});

test("cancellation after object resolution releases object without running inspection", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    assertFramePointUnoccluded(f.controller, {
      ...f.input,
      guard: async () => {
        if (++checks === 3) throw new Error("cancelled");
      },
    }),
    /cancelled/,
  );
  assert.deepEqual(f.calls, ["document", "resolve", "release"]);
});

test(
  "fixed ancestor inspector: real nested frames, overlays, inert ancestors and transforms",
  {
    skip: !process.env.ROLL_TEST_CHROME_EXECUTABLE,
  },
  async (t) => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      const styles =
        "<style>body{margin:0}iframe{position:absolute;left:40px;top:45px;width:400px;height:300px;border:3px solid black}button{position:absolute;left:30px;top:35px}</style>";
      response.end(
        styles +
          (request.url === "/two"
            ? '<button id="target">Choose</button>'
            : `<div id="wrapper"><iframe src="${request.url === "/one" ? "/two" : "/one"}"></iframe></div>`),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const site = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      executablePath: process.env.ROLL_TEST_CHROME_EXECUTABLE!,
      headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(site);
      const inner = page.frame({ url: `${site}/two` });
      assert.ok(inner);
      const box = await inner.locator("#target").boundingBox();
      assert.ok(box);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const inspect = (requireFocus = false) =>
        inner.evaluate(
          `(${INSPECT_FRAME_ANCESTORS}).call(document, ${JSON.stringify(point)}, ${JSON.stringify([site])}, ${JSON.stringify(requireFocus)})`,
        );
      assert.equal(
        await inspect(),
        "clear",
        "nested border offsets map main viewport point correctly",
      );
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "overlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:white";
        document.body.append(overlay);
      });
      assert.equal(
        await inspect(),
        "target_obscured",
        "root overlay blocks child even though child-local hit test passes",
      );
      assert.equal(
        await inner.locator("#target").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
        }),
        true,
      );
      await page.locator("#overlay").evaluate((el) => el.remove());
      const middle = page.frame({ url: `${site}/one` });
      assert.ok(middle);
      await middle.locator("#wrapper").evaluate((el) => {
        el.setAttribute("inert", "");
      });
      assert.equal(await inspect(), "target_obscured");
      await middle.locator("#wrapper").evaluate((el) => {
        el.removeAttribute("inert");
        el.style.transform = "translateX(1px)";
      });
      assert.equal(await inspect(), "coverage_gap", "unsupported transform is never guessed");
      await middle.locator("#wrapper").evaluate((el) => {
        el.style.transform = "none";
      });
      assert.equal(await inspect(), "clear");
      await inner.locator("#target").focus();
      assert.equal(await inspect(true), "clear", "focused iframe chain allows keyboard input");
      await page.evaluate(() => {
        const outside = document.createElement("input");
        outside.style.cssText = "position:absolute;left:700px;top:700px";
        document.body.append(outside);
        outside.focus();
      });
      assert.equal(
        await page.locator("input").evaluate((el) => document.activeElement === el),
        true,
      );
      assert.equal(await inspect(false), "clear", "focus movement does not obstruct pointer");
      assert.equal(
        await inspect(true),
        "focus_changed",
        "ancestor focus must still target the iframe",
      );
    } finally {
      await browser.close();
    }
  },
);
