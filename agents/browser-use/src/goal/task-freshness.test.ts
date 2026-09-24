import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserAxNode } from "@roll-agent/browser";
import type { GoalSnapshot } from "./observation.ts";
import {
  ActionDependenciesSchema,
  actionDependenciesMatch,
  captureActionDependencies,
  FormCompletionDependenciesSchema,
  captureFormCompletionDependencies,
  formCompletionDependenciesMatch,
  semanticGoalControl,
} from "./task-freshness.ts";
import { taskControlIdentity } from "./task-policy.ts";

function page(): GoalSnapshot {
  return {
    documentId: "document-1",
    browserInstance: "browser-1",
    pageId: "page-1",
    snapshotId: "snapshot-1",
    nodes: [
      {
        role: "RootWebArea",
        frameId: "root",
        backendNodeId: 100,
        value: "https://example.com/form",
        ignored: false,
        depth: 0,
        children: [
          {
            role: "form",
            name: "工作地点",
            frameId: "root",
            ignored: false,
            depth: 1,
            children: [
              {
                ref: "@e1",
                backendNodeId: 1,
                role: "textbox",
                name: "城市",
                value: "",
                properties: { required: true, invalid: "false", readonly: false },
                ignored: false,
                depth: 2,
              },
              {
                ref: "@e2",
                backendNodeId: 2,
                role: "combobox",
                name: "省份",
                value: "上海",
                ignored: false,
                depth: 2,
              },
              {
                role: "status",
                name: "城市必须与省份一致",
                ignored: false,
                depth: 2,
              },
            ],
          },
          { role: "status", name: "12:00:00", ignored: false, depth: 1 },
          {
            ref: "@e3",
            backendNodeId: 3,
            role: "textbox",
            name: "无关备注",
            value: "旧值",
            ignored: false,
            depth: 1,
          },
        ],
      },
    ],
    refs: [
      {
        ref: "@e1",
        backendNodeId: 1,
        frameId: "root",
        role: "textbox",
        name: "城市",
        nth: 0,
        disabled: false,
        context: { form: "工作地点", label: "城市" },
      },
      {
        ref: "@e2",
        backendNodeId: 2,
        frameId: "root",
        role: "combobox",
        name: "省份",
        nth: 0,
        disabled: false,
        context: { form: "工作地点", label: "省份" },
      },
      {
        ref: "@e3",
        backendNodeId: 3,
        frameId: "root",
        role: "textbox",
        name: "无关备注",
        nth: 0,
        disabled: false,
      },
    ],
    controls: {
      "@e1": { availability: "ready", editable: true, context: ["城市"] },
      "@e2": {
        availability: "ready",
        editable: false,
        context: ["省份"],
        nativeSelect: true,
        options: [{ label: "上海", value: "sh", selected: true, disabled: false }],
      },
      "@e3": { availability: "ready", editable: true, context: ["无关备注"] },
    },
    pageText: "工作地点 12:00:00 城市 省份 无关备注",
    nodeCount: 7,
    maxNodes: 240,
    truncated: false,
    interactiveOnly: true,
  };
}

function node(snapshot: GoalSnapshot, name: string): BrowserAxNode {
  const flatten = (nodes: readonly BrowserAxNode[]): BrowserAxNode[] =>
    nodes.flatMap((item) => [item, ...flatten(item.children ?? [])]);
  const result = flatten(snapshot.nodes).find((item) => item.name === name);
  assert.ok(result, `Missing test node ${name}`);
  return result;
}

test("unrelated clock, page text and another field can change without discarding a value", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const fresh = page();
  fresh.snapshotId = "snapshot-2";
  fresh.pageText = "工作地点 12:00:01 一个全新的广告内容";
  node(fresh, "12:00:00").name = "12:00:01";
  node(fresh, "无关备注").value = "别处更新了";
  assert.equal(dependencies.reusable, true);
  assert.deepEqual(ActionDependenciesSchema.parse(dependencies), dependencies);
  assert.equal(actionDependenciesMatch(dependencies, fresh), true);
});

test("ref handle churn for the same backend identity does not discard a value", () => {
  const before = page();
  const fresh = page();
  fresh.refs[0]!.ref = "@e51";
  node(fresh, "城市").ref = "@e51";
  fresh.controls!["@e51"] = fresh.controls!["@e1"]!;
  delete fresh.controls!["@e1"];
  assert.equal(
    actionDependenciesMatch(captureActionDependencies(before, before.refs[0]!), fresh),
    true,
  );
});

test("replaced backend node, missing target and ambiguous target all refuse reuse", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const replaced = page();
  replaced.refs[0]!.backendNodeId = 41;
  node(replaced, "城市").backendNodeId = 41;
  assert.equal(actionDependenciesMatch(dependencies, replaced), false);
  const missing = page();
  missing.refs.shift();
  assert.equal(actionDependenciesMatch(dependencies, missing), false);
  const duplicate = page();
  duplicate.refs.push({ ...duplicate.refs[0]!, ref: "@e91" });
  assert.equal(actionDependenciesMatch(dependencies, duplicate), false);
});

test("target value, label, readonly and aria-invalid changes invalidate a pending value", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const changes: ((fresh: GoalSnapshot) => void)[] = [
    (fresh) => {
      node(fresh, "城市").value = "北京";
    },
    (fresh) => {
      fresh.refs[0]!.name = "出生城市";
    },
    (fresh) => {
      node(fresh, "城市").properties!.readonly = true;
    },
    (fresh) => {
      node(fresh, "城市").properties!.invalid = "true";
    },
    (fresh) => {
      node(fresh, "城市").properties!.required = false;
    },
    (fresh) => {
      fresh.refs[0]!.disabled = true;
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    assert.equal(actionDependenciesMatch(dependencies, fresh), false);
  }
});

test("explicit related field values and available native options are dependencies", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!, [
    taskControlIdentity(before.refs[1]!),
  ]);
  const changedValue = page();
  node(changedValue, "省份").value = "浙江";
  assert.equal(actionDependenciesMatch(dependencies, changedValue), false);
  const changedOptions = page();
  changedOptions.controls!["@e2"]!.options!.push({
    label: "浙江",
    value: "zj",
    selected: false,
    disabled: false,
  });
  assert.equal(actionDependenciesMatch(dependencies, changedOptions), false);
  const removed = page();
  removed.refs.splice(1, 1);
  assert.equal(actionDependenciesMatch(dependencies, removed), false);
});

test("native target option selection and disabled changes invalidate a pending choice", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[1]!);
  const fresh = page();
  fresh.controls!["@e2"]!.options![0]!.disabled = true;
  assert.equal(actionDependenciesMatch(dependencies, fresh), false);
});

test("popup peers are implicit dependencies so async candidate replacement is rejected", () => {
  const before = page();
  before.controls!["@e1"]!.layerKey = "city-picker";
  before.controls!["@e2"]!.layerKey = "city-picker";
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const fresh = structuredClone(before);
  fresh.controls!["@e2"]!.options![0]!.value = "bj";
  assert.equal(actionDependenciesMatch(dependencies, fresh), false);
});

test("related validation status and global alerts are captured, including child error text", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const changedStatus = page();
  node(changedStatus, "城市必须与省份一致").name = "该城市暂不接受申请";
  assert.equal(actionDependenciesMatch(dependencies, changedStatus), false);
  const alert = page();
  alert.nodes.push({
    role: "alert",
    frameId: "root",
    ignored: false,
    depth: 0,
    children: [{ role: "StaticText", name: "城市不能为空", ignored: false, depth: 1 }],
  });
  assert.equal(actionDependenciesMatch(dependencies, alert), false);
  const withAlert = captureActionDependencies(alert, alert.refs[0]!);
  node(alert, "城市不能为空").name = "城市已失效";
  assert.equal(actionDependenciesMatch(withAlert, alert), false);
});

test("validation for an explicitly different form or iframe does not invalidate the target", () => {
  const before = page();
  const fresh = page();
  fresh.nodes.push({
    role: "form",
    frameId: "root",
    name: "其他表单",
    ignored: false,
    depth: 0,
    children: [{ role: "alert", name: "其他表单错误", ignored: false, depth: 1 }],
  });
  fresh.nodes.push({
    role: "alert",
    frameId: "foreign",
    name: "另一 iframe 错误",
    ignored: false,
    depth: 0,
  });
  assert.equal(
    actionDependenciesMatch(captureActionDependencies(before, before.refs[0]!), fresh),
    true,
  );
});

test("document, browser, page, frame and observed frame origin changes invalidate the action", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  const changes: ((fresh: GoalSnapshot) => void)[] = [
    (fresh) => {
      fresh.documentId = "document-2";
    },
    (fresh) => {
      fresh.browserInstance = "browser-2";
    },
    (fresh) => {
      fresh.pageId = "page-2";
    },
    (fresh) => {
      fresh.refs[0]!.frameId = "another-frame";
    },
    (fresh) => {
      fresh.nodes[0]!.value = "https://other.example/form";
    },
    (fresh) => {
      fresh.nodes[0]!.backendNodeId = 101;
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    assert.equal(actionDependenciesMatch(dependencies, fresh), false);
  }
});

test("availability, editable, layer and checked state changes invalidate pending input", () => {
  const before = page();
  const dependencies = captureActionDependencies(before, before.refs[0]!);
  for (const availability of ["offscreen", "covered", "hidden", "unavailable"] as const) {
    const fresh = page();
    fresh.controls!["@e1"]!.availability = availability;
    assert.equal(actionDependenciesMatch(dependencies, fresh), false);
  }
  const fresh = page();
  fresh.controls!["@e1"]!.checked = true;
  fresh.controls!["@e1"]!.editable = false;
  fresh.controls!["@e1"]!.modal = true;
  assert.equal(actionDependenciesMatch(dependencies, fresh), false);
});

test("truncation, coverage gaps and missing identity explicitly prevent reuse", () => {
  const changes: ((fresh: GoalSnapshot) => void)[] = [
    (fresh) => {
      fresh.truncated = true;
    },
    (fresh) => {
      fresh.pageTextTruncated = true;
    },
    (fresh) => {
      fresh.coverageWarnings = ["inaccessible frame"];
    },
    (fresh) => {
      delete fresh.documentId;
    },
    (fresh) => {
      delete fresh.refs[0]!.backendNodeId;
    },
    (fresh) => {
      delete fresh.controls!["@e1"];
    },
    (fresh) => {
      fresh.controls!["@e1"]!.optionsTruncated = true;
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    const captured = captureActionDependencies(fresh, fresh.refs[0]!);
    assert.equal(captured.reusable, false);
    assert.ok(captured.unavailableReasons.length > 0);
    assert.equal(actionDependenciesMatch(captured, fresh), false);
  }
});

test("focus movement and property key ordering alone preserve scoped semantics", () => {
  const before = page();
  const fresh = page();
  node(fresh, "城市").properties = {
    focused: true,
    readonly: false,
    invalid: "false",
    required: true,
  };
  assert.equal(
    actionDependenciesMatch(captureActionDependencies(before, before.refs[0]!), fresh),
    true,
  );
});

test("the known iframe coverage notice permits only fully inspected explicit frame dependencies", () => {
  const warning = "iframe_coverage_is_best_effort_oopif_may_be_missing";
  const before = page();
  before.coverageWarnings = [warning];
  const dependencies = captureActionDependencies(before, before.refs[0]!, [
    taskControlIdentity(before.refs[1]!),
  ]);
  assert.equal(dependencies.reusable, true);
  assert.deepEqual(dependencies.notedCoverageWarnings, [warning]);
  assert.deepEqual(dependencies.unavailableReasons, []);
  const fresh = structuredClone(before);
  fresh.pageText = "An unrelated iframe label changed";
  assert.equal(actionDependenciesMatch(dependencies, fresh), true);

  const missingInspection = structuredClone(before);
  delete missingInspection.controls!["@e2"];
  assert.equal(actionDependenciesMatch(dependencies, missingInspection), false);
  const unavailable = structuredClone(before);
  unavailable.controls!["@e2"]!.availability = "unavailable";
  assert.equal(actionDependenciesMatch(dependencies, unavailable), false);
  const unknownWarning = structuredClone(before);
  unknownWarning.coverageWarnings!.push("target_frame_unreadable");
  assert.equal(actionDependenciesMatch(dependencies, unknownWarning), false);
  const missingFrame = structuredClone(before);
  delete missingFrame.refs[0]!.frameId;
  assert.equal(captureActionDependencies(missingFrame, missingFrame.refs[0]!).reusable, false);
});

test("form completion ignores only independent page text clock changes", () => {
  const before = page();
  const dependencies = captureFormCompletionDependencies(before);
  assert.equal(dependencies.reusable, true);
  assert.deepEqual(FormCompletionDependenciesSchema.parse(dependencies), dependencies);
  const fresh = page();
  fresh.snapshotId = "new-snapshot";
  fresh.pageText = "时钟：12:00:01";
  assert.equal(formCompletionDependenciesMatch(dependencies, fresh), true);
});

test("form completion protects every field and its dependencies rather than only a focus", () => {
  const dependencies = captureFormCompletionDependencies(page());
  const changes: ((snapshot: GoalSnapshot) => void)[] = [
    (snapshot) => {
      node(snapshot, "无关备注").value = "用户改变了另一个字段";
    },
    (snapshot) => {
      snapshot.controls!["@e2"]!.options![0]!.disabled = true;
    },
    (snapshot) => {
      snapshot.controls!["@e2"]!.options![0]!.selected = false;
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.required = false;
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.checked = true;
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.context.push("必须另选城市");
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.validationErrors = ["城市不能使用"];
    },
    (snapshot) => {
      node(snapshot, "城市").properties!.invalid = true;
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    assert.equal(formCompletionDependenciesMatch(dependencies, fresh), false);
  }
});

test("new or removed required controls invalidate form completion even without a prepared entry", () => {
  const dependencies = captureFormCompletionDependencies(page());
  const added = page();
  added.refs.push({
    ref: "@e4",
    backendNodeId: 4,
    frameId: "root",
    role: "textbox",
    name: "新出现的必填字段",
    nth: 0,
    disabled: false,
  });
  added.nodes.push({
    ref: "@e4",
    backendNodeId: 4,
    frameId: "root",
    role: "textbox",
    name: "新出现的必填字段",
    value: "",
    ignored: false,
    depth: 0,
  });
  added.controls!["@e4"] = { availability: "ready", editable: true, context: [], required: true };
  assert.equal(formCompletionDependenciesMatch(dependencies, added), false);
  const removed = page();
  removed.refs.pop();
  assert.equal(formCompletionDependenciesMatch(dependencies, removed), false);
});

test("global alerts, statuses and non-ARIA static error text stay in completion dependencies", () => {
  const dependencies = captureFormCompletionDependencies(page());
  for (const role of ["alert", "status", "StaticText"]) {
    const fresh = page();
    fresh.nodes.push({ role, name: "服务端校验未通过", frameId: "root", ignored: false, depth: 0 });
    assert.equal(formCompletionDependenciesMatch(dependencies, fresh), false, role);
  }
  const fresh = page();
  node(fresh, "城市必须与省份一致").name = "城市不能再使用";
  assert.equal(formCompletionDependenciesMatch(dependencies, fresh), false);
});

test("picker expansion, modal commit state and document or frame change invalidate completion", () => {
  const dependencies = captureFormCompletionDependencies(page());
  const changes: ((snapshot: GoalSnapshot) => void)[] = [
    (snapshot) => {
      snapshot.controls!["@e1"]!.expanded = true;
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.modal = true;
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.layer = "尚未应用选择";
    },
    (snapshot) => {
      snapshot.documentId = "new-document";
    },
    (snapshot) => {
      snapshot.refs[0]!.frameId = "another-frame";
    },
    (snapshot) => {
      snapshot.refs[0]!.backendNodeId = 101;
    },
    (snapshot) => {
      snapshot.nodes[0]!.value = "https://other.example/form";
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    assert.equal(formCompletionDependenciesMatch(dependencies, fresh), false);
  }
});

test("completion requires observed form fields and complete control inspection", () => {
  const changes: ((snapshot: GoalSnapshot) => void)[] = [
    (snapshot) => {
      snapshot.truncated = true;
    },
    (snapshot) => {
      snapshot.pageTextTruncated = true;
    },
    (snapshot) => {
      snapshot.coverageWarnings = ["unknown-missing-frame"];
    },
    (snapshot) => {
      delete snapshot.controls!["@e3"];
    },
    (snapshot) => {
      snapshot.controls!["@e2"]!.optionsTruncated = true;
    },
    (snapshot) => {
      delete snapshot.refs[0]!.backendNodeId;
    },
  ];
  for (const change of changes) {
    const fresh = page();
    change(fresh);
    const captured = captureFormCompletionDependencies(fresh);
    assert.equal(captured.reusable, false);
    assert.ok(captured.unavailableReasons.length);
    assert.equal(formCompletionDependenciesMatch(captured, fresh), false);
  }
  const noForm = page();
  noForm.refs = [];
  noForm.nodes = [];
  noForm.controls = {};
  assert.equal(captureFormCompletionDependencies(noForm).reusable, false);
});

test("completion notes the known iframe warning only with complete explicit frame inspection", () => {
  const before = page();
  const warning = "iframe_coverage_is_best_effort_oopif_may_be_missing";
  before.coverageWarnings = [warning];
  const captured = captureFormCompletionDependencies(before);
  assert.equal(captured.reusable, true);
  assert.deepEqual(captured.notedCoverageWarnings, [warning]);
  const fresh = structuredClone(before);
  delete fresh.refs[1]!.frameId;
  assert.equal(captureFormCompletionDependencies(fresh).reusable, false);
});

test("form completion permits ref handle churn but keeps the control inventory", () => {
  const dependencies = captureFormCompletionDependencies(page());
  const fresh = page();
  fresh.refs[0]!.ref = "@e10";
  node(fresh, "城市").ref = "@e10";
  fresh.controls!["@e10"] = fresh.controls!["@e1"]!;
  delete fresh.controls!["@e1"];
  assert.equal(formCompletionDependenciesMatch(dependencies, fresh), true);
});

test("main-document controls without frameId are bound to the observed root document", () => {
  const before = page();
  before.coverageWarnings = ["iframe_coverage_is_best_effort_oopif_may_be_missing"];
  delete before.nodes[0]!.frameId;
  delete node(before, "工作地点").frameId;
  for (const ref of before.refs) delete ref.frameId;
  const captured = captureFormCompletionDependencies(before);
  assert.equal(captured.reusable, true);
  const fresh = structuredClone(before);
  fresh.nodes[0]!.backendNodeId = 101;
  assert.equal(formCompletionDependenciesMatch(captured, fresh), false);
  delete before.nodes[0]!.backendNodeId;
  assert.equal(captureFormCompletionDependencies(before).reusable, false);
});

for (const role of ["statictext", "inlinetextbox"]) {
  test(`form completion keeps ${role} child refs without requiring DOM Element inspection`, () => {
    const before: GoalSnapshot = {
      documentId: "doc",
      snapshotId: "before",
      nodeCount: 2,
      maxNodes: 240,
      truncated: false,
      interactiveOnly: true,
      coverageWarnings: [],
      pageText: "姓名 周小青 时间12:00:00",
      refs: [
        {
          ref: "@e1",
          backendNodeId: 100,
          frameId: "root",
          role: "textbox",
          name: "姓名",
          nth: 0,
          disabled: false,
        },
        {
          ref: "@e2",
          backendNodeId: 101,
          frameId: "root",
          role,
          name: "周小青",
          nth: 0,
          disabled: false,
        },
      ],
      nodes: [
        {
          ref: "@e1",
          backendNodeId: 100,
          frameId: "root",
          role: "textbox",
          name: "姓名",
          value: "周小青",
          ignored: false,
          depth: 0,
          children: [
            {
              ref: "@e2",
              backendNodeId: 101,
              frameId: "root",
              role,
              name: "周小青",
              ignored: false,
              depth: 1,
            },
          ],
        },
      ],
      controls: {
        "@e1": { availability: "ready", editable: true, context: ["姓名"] },
        "@e2": { availability: "unavailable", editable: false, context: [] },
      },
    };
    const captured = captureFormCompletionDependencies(before);
    assert.equal(captured.reusable, true, JSON.stringify(captured.unavailableReasons));
    assert.equal(captured.fieldCount, 1);
    assert.equal(captured.controlIdentities.length, 1);
    const fresh = structuredClone(before);
    fresh.snapshotId = "after";
    fresh.pageText = "姓名 周小青 时间12:00:01";
    assert.equal(formCompletionDependenciesMatch(captured, fresh), true);
    node(fresh, "周小青").name = "周大青";
    assert.equal(formCompletionDependenciesMatch(captured, fresh), false);
    const newIdentity = structuredClone(before);
    newIdentity.refs[1]!.backendNodeId = 102;
    node(newIdentity, "周小青").backendNodeId = 102;
    assert.equal(formCompletionDependenciesMatch(captured, newIdentity), false);
    const missingControl = structuredClone(before);
    missingControl.controls!["@e1"]!.availability = "unavailable";
    assert.equal(captureFormCompletionDependencies(missingControl).reusable, false);
    const unknownScope = structuredClone(before);
    unknownScope.coverageWarnings = ["frame_scope_missing"];
    assert.equal(captureFormCompletionDependencies(unknownScope).reusable, false);
  });
}

test("semantic control data omits only position and does not mutate its input", () => {
  const control = {
    ...page().controls!["@e1"]!,
    position: { top: 10, left: 20 },
    ownerPaths: ["html/body/form/input"],
    ancestorPaths: ["html/body/form"],
    requiredSource: "html" as const,
  };
  const { position: _position, ...expected } = control;
  assert.deepEqual(semanticGoalControl(control), expected);
  assert.deepEqual(control.position, { top: 10, left: 20 });
});

test("position-only movement preserves action and complete-form semantic dependencies", () => {
  const before = page();
  Object.assign(before.controls!["@e1"]!, { position: { top: 100, left: 200 } });
  Object.assign(before.controls!["@e2"]!, { position: { top: 140, left: 200 } });
  const action = captureActionDependencies(before, before.refs[0]!, [
    taskControlIdentity(before.refs[1]!),
  ]);
  const completion = captureFormCompletionDependencies(before);
  const fresh = structuredClone(before);
  Object.assign(fresh.controls!["@e1"]!, { position: { top: 40, left: 220 } });
  Object.assign(fresh.controls!["@e2"]!, { position: { top: 80, left: 220 } });
  assert.equal(actionDependenciesMatch(action, fresh), true);
  assert.equal(formCompletionDependenciesMatch(completion, fresh), true);
});

test("ignoring position does not ignore occlusion, changed field meaning or ownership paths", () => {
  const before = page();
  Object.assign(before.controls!["@e1"]!, {
    position: { top: 100, left: 200 },
    ownerPaths: ["html/body/form/input"],
    ancestorPaths: ["html/body/form"],
    requiredSource: "html" as const,
  });
  const action = captureActionDependencies(before, before.refs[0]!);
  const completion = captureFormCompletionDependencies(before);
  const changes: ((snapshot: GoalSnapshot) => void)[] = [
    (snapshot) => {
      snapshot.controls!["@e1"]!.availability = "covered";
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.availability = "offscreen";
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.fieldLabel = "出生城市";
    },
    (snapshot) => {
      Object.assign(snapshot.controls!["@e1"]!, { ownerPaths: ["html/body/another-form/input"] });
    },
    (snapshot) => {
      Object.assign(snapshot.controls!["@e1"]!, { ancestorPaths: ["html/body/another-form"] });
    },
    (snapshot) => {
      Object.assign(snapshot.controls!["@e1"]!, { requiredSource: "aria" });
    },
    (snapshot) => {
      snapshot.controls!["@e1"]!.validationErrors = ["城市选择无效"];
    },
  ];
  for (const change of changes) {
    const fresh = structuredClone(before);
    Object.assign(fresh.controls!["@e1"]!, { position: { top: 40, left: 220 } });
    change(fresh);
    assert.equal(actionDependenciesMatch(action, fresh), false);
    assert.equal(formCompletionDependenciesMatch(completion, fresh), false);
  }
});

test("modal-hidden related DOM controls preserve scoped freshness but never become action targets", () => {
  const snapshot = page();
  const related = snapshot.refs.splice(1, 1)[0]!;
  const identity = taskControlIdentity(related);
  snapshot.dependencyControls = {
    [identity]: {
      ref: related,
      control: {
        availability: "covered",
        editable: false,
        context: ["省份"],
        observedValue: "上海",
        domSemantics: { tag: "select", role: "", disabled: false, readOnly: false },
        constraints: { min: "1" },
      },
    },
  };
  const expected = captureActionDependencies(snapshot, snapshot.refs[0]!, [identity]);
  assert.equal(expected.reusable, true);
  const fresh = structuredClone(snapshot);
  fresh.pageText = "clock changed";
  assert.equal(actionDependenciesMatch(expected, fresh), true);
  assert.equal(captureActionDependencies(snapshot, related).reusable, false);
  for (const mutate of [
    (s: GoalSnapshot) => {
      s.dependencyControls![identity]!.control.constraints = { min: "2" };
    },
    (s: GoalSnapshot) => {
      s.dependencyControls![identity]!.control.observedValue = "北京";
    },
    (s: GoalSnapshot) => {
      s.dependencyControls![identity]!.control.domSemantics!.role = "button";
    },
    (s: GoalSnapshot) => {
      s.dependencyControls![identity]!.control.availability = "unavailable";
    },
    (s: GoalSnapshot) => {
      s.dependencyControls![identity]!.ref.frameId = "foreign";
    },
    (s: GoalSnapshot) => {
      s.dependencyControls = {};
    },
    (s: GoalSnapshot) => {
      s.documentId = "replaced";
    },
  ]) {
    const changed = structuredClone(snapshot);
    mutate(changed);
    assert.equal(actionDependenciesMatch(expected, changed), false);
  }
});
