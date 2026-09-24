import assert from "node:assert/strict";
import { test } from "node:test";
import { createFormLoopProgress, observeFormLoopProgress } from "./form-loop-progress.ts";
import { createFormState } from "./form-context.ts";
import type { GoalSnapshot } from "./observation.ts";

const form = () =>
  createFormState(
    {
      mode: "create",
      stopAt: "current-view",
      fields: [{ name: "Salary", intent: "set", valueName: "salary", comparison: "literal" }],
    },
    [{ name: "salary", text: "8" }],
  );
function page(label: string, id: number): GoalSnapshot {
  return {
    snapshotId: `s${id}`,
    documentId: "doc",
    nodeCount: 1,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
    nodes: [{ ref: `@e${id}`, role: "option", name: label, ignored: false, depth: 0 }],
    refs: [
      { ref: `@e${id}`, role: "option", name: label, backendNodeId: id, nth: 0, disabled: false },
    ],
  };
}
const scroll = { operation: "SCROLL_DOWN", executed: true };
test("open/close and scroll cycles survive recreated refs and stop at the third visit", () => {
  for (const labels of [
    ["closed", "open"],
    ["3k", "19k", "60k"],
  ]) {
    const m = createFormLoopProgress();
    const f = form();
    for (let i = 0; i < labels.length * 2; i++) {
      assert.equal(
        observeFormLoopProgress(m, page(labels[i % labels.length]!, i), f, scroll),
        false,
      );
    }
    assert.equal(observeFormLoopProgress(m, page(labels[0]!, 999), f, scroll), true);
  }
});
test("new option ranges, changed field values and document changes are not stalled states", () => {
  const m = createFormLoopProgress();
  const f = form();
  for (let i = 0; i < 30; i++) {
    assert.equal(observeFormLoopProgress(m, page(`${i}k`, i), f, scroll), false);
  }
  for (let i = 0; i < 4; i++) {
    f.fields[0]!.current = String(i);
    assert.equal(observeFormLoopProgress(m, page("same", i), f, scroll), false);
  }
  const s = page("same", 9);
  for (let i = 0; i < 5; i++) {
    assert.equal(observeFormLoopProgress(m, { ...s, documentId: `doc${i}` }, f, scroll), false);
  }
});
test("non-dispatched, planning and busy observations do not spend cycle attempts", () => {
  const m = createFormLoopProgress();
  const f = form();
  const s = page("same", 1);
  for (let i = 0; i < 8; i++) {
    assert.equal(
      observeFormLoopProgress(m, s, f, { operation: "UPDATE_EXECUTION_CONTEXT", executed: false }),
      false,
    );
    assert.equal(observeFormLoopProgress(m, s, f, { ...scroll, error: "rejected" }), false);
    assert.equal(
      observeFormLoopProgress(
        m,
        { ...s, pageState: { panels: [], selectedTabs: [], busy: true } },
        f,
        scroll,
      ),
      false,
    );
  }
  assert.equal(m.visits.size, 0);
});
