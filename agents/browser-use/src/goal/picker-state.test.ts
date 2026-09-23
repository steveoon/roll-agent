import test from "node:test";
import assert from "node:assert/strict";
import { PickerEvidenceSchema } from "./picker-observation.ts";
import { createPickerMemory, pickerActionLabel } from "./picker-state.ts";
import { taskState, buildTaskDecisionRequest } from "./task-policy.ts";
import { BrowserOperateInputSchema } from "./contracts.ts";
import type { GoalSnapshot } from "./observation.ts";

function snapshot(selected = false, backend = 2): GoalSnapshot {
  const refs = [
    { ref: "@a", name: "选择配送", backendNodeId: 1 },
    { ref: "@b", name: selected ? "默认" : "选择付款", backendNodeId: backend },
    { ref: "@o", name: "默认", backendNodeId: 3 },
  ].map((r) => ({ ...r, role: "clickable", disabled: false, nth: 0 }));
  return {
    documentId: "doc",
    snapshotId: "s",
    nodeCount: 3,
    maxNodes: 50,
    truncated: false,
    interactiveOnly: true,
    refs,
    nodes: refs.map((r) => ({ ref: r.ref, role: r.role, name: r.name, depth: 0, ignored: false })),
    controls: Object.fromEntries(
      refs.map((ref, i) => [
        ref.ref,
        {
          availability: "ready",
          editable: false,
          context: ["配送及付款"],
          displayText: ref.name,
          picker: PickerEvidenceSchema.parse({
            part: i === 2 ? "option" : "trigger",
            relationship: "local-dom",
            triggerPath: i === 0 ? "/a" : "/b",
            panelPaths: [i === 0 ? "/a/menu" : "/b/menu"],
            ...(i === 0 || !selected
              ? { label: i === 0 ? "选择配送" : "选择付款", labelSource: "placeholder" }
              : {}),
            expanded: i > 0,
            selection: i > 0 && selected ? "value" : "empty",
            selectionEvidence: "backing-input",
            ...(i > 0 && selected ? { committedText: "默认" } : {}),
            ...(i === 2 ? { optionText: "默认" } : {}),
          }),
        },
      ]),
    ),
  };
}
const input = BrowserOperateInputSchema.parse({
  pageId: "p",
  goal: "配送和付款都选默认",
  values: [
    { name: "配送", text: "默认" },
    { name: "付款", text: "默认" },
  ],
  allowedOrigins: ["https://example.com"],
});

test("stable field label survives selection, but not replacement or another frame/document", () => {
  const memory = createPickerMemory();
  memory.observe(snapshot());
  let state = memory.observe(snapshot(true));
  assert.equal(state.fields[1]?.label, "选择付款");
  assert.equal(state.fields[1]?.labelOrigin, "earlier-dom-placeholder");
  assert.equal(state.parts["@o"]?.fieldId, state.parts["@b"]?.fieldId);
  assert.notEqual(state.parts["@o"]?.fieldId, state.parts["@a"]?.fieldId);
  state = memory.observe(snapshot(true, 99));
  assert.equal(state.fields[1]?.label, undefined);
  const other = snapshot(true);
  other.refs = other.refs.map((r) => ({ ...r, frameId: "other-frame" }));
  assert.equal(memory.observe(other).fields[1]?.label, undefined);
  const another = snapshot(true);
  another.documentId = "new-document";
  assert.equal(memory.observe(another).fields[1]?.label, undefined);
});

test("candidate display text never becomes a committed value or a completed source match", () => {
  const page = snapshot(true);
  const memory = createPickerMemory();
  memory.observe(snapshot());
  const pickers = memory.observe(page);
  const state = taskState(input, page, [], "", [], pickers);
  const option = state.elements.find((e) => e.ref === "@o")!;
  assert.equal(option.value, undefined);
  assert.equal(option.displayText, "默认");
  assert.equal(option.valueKind, "option-label");
  assert.deepEqual(option.sourceValueMatches, []);
  assert.equal(state.elements.find((e) => e.ref === "@a")?.valueKind, "placeholder");
  const request = buildTaskDecisionRequest(input, page, [], "", new Set(), [], pickers);
  assert.match(request.questions.operation!.criteria["CLICK:@b"]!, /trigger, NOT an option/);
  assert.match(request.questions.operation!.criteria["CLICK:@o"]!, /Select candidate.*选择付款/);
  assert.match(request.questions.operation!.criteria.DONE!, /committed/i);
});

test("ambiguous ownership is preserved rather than assigned to the nearest field", () => {
  const page = snapshot();
  page.controls!["@o"]!.picker = PickerEvidenceSchema.parse({
    part: "option",
    relationship: "unknown",
    panelPaths: [],
    selection: "unknown",
    selectionEvidence: "unknown",
    optionText: "默认",
  });
  const state = createPickerMemory().observe(page);
  assert.equal(state.parts["@o"]?.fieldId, undefined);
  assert.match(pickerActionLabel(page.refs[2]!, state), /owner unknown/);
});

test("missing document identity cannot carry a historical field label", () => {
  const memory = createPickerMemory();
  const before = snapshot();
  delete before.documentId;
  const after = snapshot(true);
  delete after.documentId;
  memory.observe(before);
  assert.equal(memory.observe(after).fields[1]?.label, undefined);
});
