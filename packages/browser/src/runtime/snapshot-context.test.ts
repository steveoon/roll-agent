import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enrichBrowserSnapshot,
  readBrowserDocumentIdentity,
  resolveBrowserSnapshotScope,
} from "./snapshot-context.ts";
import type { BrowserAxSnapshot } from "../types/index.ts";

const snapshot: BrowserAxSnapshot = {
  nodes: [
    { role: "button", name: "Save", ignored: false, depth: 0, backendNodeId: 4, ref: "@e1" },
    { role: "button", name: "Save", ignored: false, depth: 0, backendNodeId: 6, ref: "@e2" },
  ],
  refs: [
    { ref: "@e1", role: "button", name: "Save", nth: 0, disabled: false, backendNodeId: 4 },
    { ref: "@e2", role: "button", name: "Save", nth: 1, disabled: false, backendNodeId: 6 },
  ],
  nodeCount: 2,
  maxNodes: 100,
  interactiveOnly: true,
  truncated: false,
};
function controller() {
  return {
    async getFrameTree() {
      return { frame: { id: "main", loaderId: "load1", url: "https://example.com" } };
    },
    async getDocument() {
      return {
        root: {
          nodeId: 1,
          backendNodeId: 100,
          children: [
            {
              nodeId: 2,
              backendNodeId: 2,
              localName: "dialog",
              attributes: ["aria-label", "Profile"],
              children: [
                {
                  nodeId: 3,
                  backendNodeId: 3,
                  localName: "form",
                  attributes: ["id", "editor"],
                  children: [
                    {
                      nodeId: 4,
                      backendNodeId: 4,
                      localName: "button",
                      attributes: ["id", "save"],
                    },
                    { nodeId: 5, backendNodeId: 5, localName: "canvas" },
                  ],
                },
              ],
            },
            { nodeId: 6, backendNodeId: 6, localName: "button" },
            {
              nodeId: 7,
              backendNodeId: 7,
              localName: "iframe",
              contentDocument: {
                nodeId: 8,
                backendNodeId: 8,
                localName: "#document",
                children: [{ nodeId: 9, backendNodeId: 9, localName: "canvas" }],
              },
            },
          ],
        },
      };
    },
    async querySelectorAllByNodeId(input: { selector: string }) {
      if (input.selector === "#editor") return [3];
      if (input.selector === '[id="save"]') return [4];
      if (input.selector === "button") return [4, 6];
      return [];
    },
  };
}

test("observation includes bounded form/dialog context, unique locator and coverage gaps", async () => {
  const result = await enrichBrowserSnapshot({
    controller: controller(),
    snapshot,
    browserInstance: "a",
    pageId: "p",
  });
  assert.equal(result.documentId, JSON.stringify(["main", "load1", 100]));
  assert.ok(result.snapshotId);
  assert.deepEqual(result.refs[0]?.context, { form: "editor", dialog: "Profile" });
  assert.deepEqual(result.refs[0]?.locator, { css: '[id="save"]', unique: true });
  assert.equal(result.refs[1]?.locator, undefined);
  assert.ok(result.coverageWarnings?.includes("canvas_requires_visual_observation"));
  assert.ok(
    result.coverageWarnings?.includes("iframe_coverage_is_best_effort_oopif_may_be_missing"),
  );
});

test("scope limits nodes and refs and rejects missing or ambiguous roots", async () => {
  const input = { controller: controller(), snapshot, browserInstance: "a", pageId: "p" };
  const result = await enrichBrowserSnapshot({ ...input, scope: "#editor" });
  assert.equal(result.nodeCount, 1);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]?.ref, "@e1");
  await assert.rejects(enrichBrowserSnapshot({ ...input, scope: "button" }), /exactly one/);
  await assert.rejects(enrichBrowserSnapshot({ ...input, scope: "#missing" }), /exactly one/);
});

test("document identity fails closed on unavailable metadata", async () => {
  assert.equal(
    await readBrowserDocumentIdentity(controller()),
    JSON.stringify(["main", "load1", 100]),
  );
  await assert.rejects(
    readBrowserDocumentIdentity({
      ...controller(),
      getDocument: async () => ({ root: { nodeId: 1 } }),
    }),
    /backend node/,
  );
});

test("navigation loader changes invalidate identity even when backend node ids are reused", async () => {
  const first = await readBrowserDocumentIdentity(controller());
  const second = await readBrowserDocumentIdentity({
    ...controller(),
    getFrameTree: async () => ({
      frame: { id: "main", loaderId: "load2", url: "https://example.com" },
    }),
  });
  assert.notEqual(first, second);
  await assert.rejects(
    readBrowserDocumentIdentity({
      ...controller(),
      getFrameTree: async () => ({ frame: { id: "main", url: "https://example.com" } }),
    }),
    /loader/,
  );
});

test("late scope is resolved before unrelated DOM consumes the context scan budget", async () => {
  const base = controller();
  const late = {
    ...base,
    getDocument: async () => ({
      root: {
        nodeId: 1,
        backendNodeId: 100,
        children: [
          ...Array.from({ length: 10_100 }, (_, i) => ({
            nodeId: i + 10,
            backendNodeId: i + 1000,
            localName: "button",
          })),
          {
            nodeId: 50_000,
            backendNodeId: 50_000,
            localName: "form",
            attributes: ["id", "late"],
            children: [
              { nodeId: 50_001, backendNodeId: 4, localName: "button", attributes: ["id", "save"] },
            ],
          },
        ],
      },
    }),
    querySelectorAllByNodeId: async ({ selector }: { selector: string }) =>
      selector === "#late" ? [50_000] : selector === '[id="save"]' ? [50_001] : [],
  };
  const resolved = await resolveBrowserSnapshotScope({ controller: late, scope: "#late" });
  assert.deepEqual(resolved.backendNodeIds, [50_000, 4]);
  const enriched = await enrichBrowserSnapshot({
    controller: late,
    snapshot,
    browserInstance: "a",
    pageId: "p",
    scope: "#late",
  });
  assert.equal(enriched.refs.length, 1);
  assert.equal(enriched.refs[0]?.name, "Save");
  assert.equal(enriched.refs[0]?.context?.form, "late");
  assert.equal(enriched.refs[0]?.strict, true);
});
