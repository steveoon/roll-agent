import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BrowserScriptPageDriver } from "./native-driver.ts";
import type { BrowserScriptPageDriverOptions } from "./native-driver.ts";
import { BrowserScriptError } from "./contracts.ts";

function fixture(overrides: Partial<BrowserScriptPageDriverOptions> = {}) {
  const events: string[] = [];
  let url = "https://example.com/form";
  let nodes = [2];
  let reads = 0;
  let declaration = "";
  let inspection = {
    attached: true,
    visible: true,
    enabled: true,
    checked: false,
    hit: true,
    editable: true,
    focused: true,
    text: "Save",
    value: "",
    href: "",
    navigationUrl: "",
    documentUrl: url,
    inScope: true,
    scopeMatches: 1,
  };
  const controller: BrowserScriptPageDriverOptions["controller"] = {
    getFrameTree: async () => ({
      frame: { id: "main", url },
      childFrames: [{ frame: { id: "child", url: "https://other.example/frame" } }],
    }),
    getDocument: async () => ({ root: { nodeId: 1 } }),
    querySelectorAllByNodeId: async () => nodes,
    describeNode: async ({ nodeId }) => ({ backendNodeId: nodeId! + 100 }),
    getFullAccessibilityTree: async () =>
      nodes.map((id) => ({
        backendDOMNodeId: id + 100,
        role: { value: "button" },
        name: { value: "Save" },
      })),
    resolveBackendNode: async ({ backendNodeId }) => `object-${backendNodeId}`,
    callFunctionOnObject: async ({ functionDeclaration }) => {
      reads++;
      declaration = functionDeclaration;
      if (functionDeclaration.includes("const clean =")) {
        const location = new URL(url);
        return {
          url: location.origin + location.pathname,
          title: "Example",
          dialogs: [],
          focused: { tag: "input", role: "", name: "Name" },
          scopeMatches: 1,
        };
      }
      return inspection;
    },
    releaseObject: async () => {},
    dispatchMouseEvent: async ({ type }) => {
      events.push(type);
    },
    dispatchKeyEvent: async ({ type }) => {
      events.push(type);
    },
    insertText: async (text) => {
      events.push("insertText");
      inspection = { ...inspection, value: text };
    },
    preflightAction: () => {},
    getBoxModelByBackendNodeId: async () => ({ content: [0, 0, 100, 0, 100, 40, 0, 40] }),
    scrollIntoViewByBackendNodeId: async () => {
      events.push("scrollIntoView");
    },
    evaluateJson: async () => {
      throw new Error("Unexpected generic evaluate fallback");
    },
    navigate: async (next) => {
      events.push("navigate");
      url = next;
      return { frameId: "main" };
    },
    captureScreenshot: async () => "aW1hZ2U=",
  };
  const driver = new BrowserScriptPageDriver({
    controller,
    pageId: "page-1",
    browserInstance: "instance-1",
    allowedOrigins: ["https://example.com"],
    capabilities: ["read", "interact", "navigate", "capture"],
    guard: async () => {},
    observe: async () => ({ snapshotId: "snapshot-1", text: "button Save" }),
    resolveRef: async (ref, snapshotId) =>
      snapshotId === "snapshot-1"
        ? {
            ref,
            backendNodeId: 102,
            frameId: "main",
            role: "button",
            name: "Save",
            nth: 0,
            disabled: false,
          }
        : undefined,
    capture: async () => ({ id: "shot", path: "/tmp/example.png", mimeType: "image/png" }),
    ...overrides,
  });
  return {
    driver,
    events,
    controller,
    setNodes: (next: number[]) => {
      nodes = next;
    },
    setInspection: (next: Partial<typeof inspection>) => {
      inspection = { ...inspection, ...next };
    },
    setUrl: (next: string) => {
      url = next;
    },
    reads: () => reads,
    declaration: () => declaration,
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof BrowserScriptError && error.code === expected;
}

test("driver reuses strict ref input pipeline and verifies filled value", async () => {
  const { driver, events } = fixture();
  assert.deepEqual(
    await driver.invoke("fill", [
      { css: "#name" },
      "Alice",
      { expect: { target: { css: "#name" }, value: "Alice" } },
    ]),
    { executed: true, verification: "passed" },
  );
  assert.ok(events.includes("insertText"));
  assert.equal(driver.checks.length, 1);
  assert.equal(driver.checks[0]?.passed, true);
  assert.equal(driver.lastActionExecuted, true);
  assert.deepEqual(await driver.invoke("read", [{ role: "button", name: "Save" }]), {
    text: "Save",
    href: "",
    visible: true,
    enabled: true,
    checked: false,
    value: "Alice",
  });
  assert.equal(driver.lastActionExecuted, false);
  assert.equal(driver.lastVerification, "not_requested");
});

test("unique targets, exact snapshot refs and missing targets fail safely", async () => {
  const { driver, events, setNodes } = fixture();
  setNodes([2, 3]);
  await assert.rejects(driver.invoke("click", [{ css: "button" }]), code("ambiguous_target"));
  assert.equal(await driver.invoke("count", [{ css: "button" }]), 2);
  assert.equal(await driver.invoke("exists", [{ css: "button" }]), true);
  setNodes([]);
  assert.equal(await driver.invoke("exists", [{ css: "button" }]), false);
  await assert.rejects(driver.invoke("read", [{ css: "button" }]), code("target_not_found"));
  await assert.rejects(
    driver.invoke("click", [{ ref: "@e1", snapshotId: "old" }]),
    code("stale_target"),
  );
  assert.deepEqual(events, []);
});

test("disabled and occluded nodes never receive Input events", async () => {
  for (const state of [{ enabled: false }, { hit: false }]) {
    const f = fixture();
    f.setInspection(state);
    await assert.rejects(f.driver.invoke("click", [{ css: "button" }]));
    assert.equal(
      f.events.some((event) => event.startsWith("mouse")),
      false,
    );
  }
});

test("guard is reevaluated before every Input command and cannot be swallowed by ref resolution", async () => {
  const f = fixture();
  let blocked = false;
  f.controller.dispatchMouseEvent = async ({ type }) => {
    f.events.push(type);
    blocked = true;
  };
  const driver = new BrowserScriptPageDriver({
    controller: f.controller,
    pageId: "p",
    browserInstance: "i",
    allowedOrigins: ["https://example.com"],
    capabilities: ["read", "interact"],
    guard: async () => {
      if (blocked) throw new BrowserScriptError("policy_changed", "policy changed");
    },
    observe: async () => ({}),
    resolveRef: async () => undefined,
    capture: async () => ({ id: "s", path: "/tmp/a.png", mimeType: "image/png" }),
  });
  await assert.rejects(driver.invoke("click", [{ css: "button" }]), code("policy_changed"));
  assert.deepEqual(f.events, ["scrollIntoView", "mouseMoved"]);
  blocked = false;
  await assert.rejects(driver.invoke("click", [{ css: "button" }]), code("policy_changed"));
  assert.deepEqual(f.events, ["scrollIntoView", "mouseMoved"]);
});

test("out-of-origin frame, link and navigation are rejected before dispatch", async () => {
  const frame = fixture();
  await assert.rejects(
    frame.driver.invoke("read", [{ css: "button", frameId: "child" }]),
    code("origin_blocked"),
  );
  const link = fixture();
  link.setInspection({ navigationUrl: "https://outside.example/steal" });
  await assert.rejects(link.driver.invoke("click", [{ css: "a" }]), code("origin_blocked"));
  assert.equal(
    link.events.some((event) => event.startsWith("mouse")),
    false,
  );
  const navigation = fixture();
  await assert.rejects(
    navigation.driver.invoke("goto", ["file:///tmp/test"]),
    code("origin_blocked"),
  );
  assert.deepEqual(navigation.events, []);
});

test("verification failure records explicit failed check and screenshot returns artifact only", async () => {
  const { driver } = fixture();
  await assert.rejects(
    driver.invoke("expect", [{ target: { css: "#name" }, value: "wrong" }, { timeoutMs: 0 }]),
    code("verification_failed"),
  );
  assert.equal(driver.checks[0]?.passed, false);
  assert.equal(driver.lastVerification, "failed");
  assert.deepEqual(await driver.invoke("screenshot", []), {
    id: "shot",
    path: "/tmp/example.png",
    mimeType: "image/png",
  });
  await assert.rejects(driver.invoke("press", ["Enter"]), code("focus_required"));
  driver.close();
  await assert.rejects(driver.invoke("read", [{ css: "button" }]), code("cancelled"));
});

test("read does not accept secret attributes; fixed inspector omits password values", async () => {
  const f = fixture();
  await assert.rejects(f.driver.invoke("read", [{ css: "input" }, { attribute: "data-secret" }]));
  await f.driver.invoke("read", [{ css: "input" }]);
  const inspect = runInNewContext(`(${f.declaration()})`) as (
    this: unknown,
    scope: unknown,
    attribute: unknown,
  ) => unknown;
  const element = {
    nodeType: 1,
    isConnected: true,
    tagName: "INPUT",
    value: "never-return-this",
    innerText: "",
    readOnly: false,
    getAttribute: (name: string) => (name === "type" ? "password" : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
    matches: () => false,
    closest: () => null,
    contains: () => true,
    ownerDocument: {
      URL: "https://example.com/form",
      defaultView: {
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
      contains: () => true,
      elementFromPoint: () => element,
      activeElement: null,
    },
  };
  const result = inspect.call(element, null, null);
  assert.doesNotMatch(JSON.stringify(result), /never-return-this|"value"/);
});

test("observe uses compact native metadata and snapshot remains explicit", async () => {
  let snapshots = 0;
  const f = fixture({
    observe: async () => {
      snapshots++;
      return { snapshotId: "full-1", text: "Full AX content" };
    },
  });
  f.controller.getFullAccessibilityTree = async () => {
    throw new Error("observe must not read AX");
  };
  f.setUrl("https://example.com/form?private=query#fragment");
  assert.deepEqual(await f.driver.invoke("observe", []), {
    url: "https://example.com/form",
    title: "Example",
    dialogs: [],
    focused: { tag: "input", role: "", name: "Name" },
  });
  assert.equal(snapshots, 0);
  const observe = runInNewContext(`(${f.declaration()})`, { URL }) as (
    this: unknown,
    scope: unknown,
  ) => unknown;
  const active = {
    tagName: "INPUT",
    value: "never-read-password",
    getAttribute: (name: string) => (name === "aria-label" ? "Password" : null),
  };
  const doc = {
    nodeType: 9,
    URL: "https://example.com/form?private=query#fragment",
    title: "x".repeat(1000),
    activeElement: active,
    querySelectorAll: () => [],
    contains: () => true,
    defaultView: {},
  };
  const actual = observe.call(doc, null);
  assert.doesNotMatch(JSON.stringify(actual), /never-read-password|private=query|fragment/);
  assert.equal((actual as { title: string }).title.length, 160);
  await f.driver.invoke("snapshot", []);
  assert.equal(snapshots, 1);
});

test("failed verification retains bounded actual evidence and success omits text values", async () => {
  const f = fixture();
  f.setInspection({ text: "actual-".repeat(200), value: "actual input" });
  await assert.rejects(
    f.driver.invoke("expect", [
      { target: { css: "h1" }, text: "expected-secret" },
      { timeoutMs: 0 },
    ]),
    code("verification_failed"),
  );
  assert.equal(f.driver.checks[0]?.actual?.text?.length, 500);
  assert.equal(f.driver.checks[0]?.actual?.matched, 1);
  assert.doesNotMatch(JSON.stringify(f.driver.checks), /expected-secret/);
  await f.driver.invoke("expect", [
    { target: { css: "input" }, value: "actual input" },
    { timeoutMs: 0 },
  ]);
  assert.equal(f.driver.checks[1]?.actual?.value, undefined);
  f.setUrl("https://example.com/form?actual-secret=true");
  await assert.rejects(
    f.driver.invoke("expect", [
      { url: "https://example.com/other?expected-secret=true" },
      { timeoutMs: 0 },
    ]),
    code("verification_failed"),
  );
  assert.equal(f.driver.checks[2]?.actual?.url, "https://example.com/form");
  assert.doesNotMatch(JSON.stringify(f.driver.checks), /actual-secret|expected-secret/);
  f.setNodes([2, 3]);
  await assert.rejects(
    f.driver.invoke("expect", [{ target: { css: "input" }, state: "visible" }, { timeoutMs: 0 }]),
    code("ambiguous_target"),
  );
  assert.equal(f.driver.checks[3]?.actual?.matched, 2);
});

test("moving target cannot receive stale mouse down/up coordinates, including frame refs", async () => {
  for (const frameId of ["main", "child"]) {
    const f = fixture({
      resolveRef: async (ref) => ({
        ref,
        backendNodeId: 102,
        frameId,
        role: "button",
        name: "Save",
        nth: 0,
        disabled: false,
      }),
    });
    f.controller.getFrameTree = async () => ({
      frame: { id: "main", url: "https://example.com/form" },
      childFrames: [{ frame: { id: "child", url: "https://example.com/frame" } }],
    });
    f.controller.getDocument = async () => ({
      root: {
        nodeId: 1,
        children: [{ frameId: "child", contentDocument: { nodeId: 2, backendNodeId: 999 } }],
      },
    });
    const inspectNode = f.controller.callFunctionOnObject;
    f.controller.callFunctionOnObject = async (input) =>
      input.objectId === "object-999" ? "clear" : await inspectNode(input);
    let left = 50;
    f.controller.getBoxModelByBackendNodeId = async () => ({
      border: [left, 80, left + 100, 80, left + 100, 120, left, 120],
    });
    f.controller.dispatchMouseEvent = async ({ type }) => {
      f.events.push(type);
      if (type === "mouseMoved") left = 350;
    };
    await assert.rejects(
      f.driver.invoke("click", [{ ref: "@e1", snapshotId: "snapshot-1" }]),
      code("target_moved"),
    );
    assert.deepEqual(f.events, ["scrollIntoView", "mouseMoved"]);
    assert.equal(f.driver.lastActionExecuted, true);
  }
});

test("scroll checks its outgoing wheel point again after mousemove moves target", async () => {
  const f = fixture();
  let left = 0;
  f.controller.getBoxModelByBackendNodeId = async () => ({
    content: [left, 0, left + 100, 0, left + 100, 40, left, 40],
  });
  f.controller.dispatchMouseEvent = async ({ type }) => {
    f.events.push(type);
    if (type === "mouseMoved") left = 300;
  };
  await assert.rejects(
    f.driver.invoke("scroll", [{ css: "#list" }, { dy: 400 }]),
    code("target_moved"),
  );
  assert.deepEqual(f.events, ["scrollIntoView", "mouseMoved"]);
});
