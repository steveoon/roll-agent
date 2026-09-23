import { createHash } from "node:crypto";
import type { BrowserAxNode, BrowserElementRef } from "@roll-agent/browser";
import { z } from "zod";
import type { GoalControl, GoalSnapshot } from "./observation.ts";
import { taskControlIdentity } from "./task-policy.ts";

export const ActionDependenciesSchema = z.object({
  documentId: z.string().nullable(),
  browserInstance: z.string().nullable(),
  pageId: z.string().nullable(),
  targetIdentity: z.string(),
  relatedIdentities: z.array(z.string()),
  reusable: z.boolean(),
  unavailableReasons: z.array(z.string()),
  notedCoverageWarnings: z.array(z.string()),
  fingerprint: z.string(),
});
export type ActionDependencies = z.infer<typeof ActionDependenciesSchema>;

/** Position guides visual ordering, but movement alone is not a semantic change.
 * Availability includes live hit testing and must remain part of every guard.
 * Keep all other metadata, including ownership paths and constraint provenance.
 */
export function semanticGoalControl(control: GoalControl): Omit<GoalControl, "position"> {
  const semantic = { ...control };
  Reflect.deleteProperty(semantic, "position");
  return semantic;
}

const scopeRoles = new Set(["form", "dialog", "alertdialog", "group", "radiogroup"]);

function nodeEntries(snapshot: GoalSnapshot) {
  const visit = (
    nodes: readonly BrowserAxNode[],
    ancestors: readonly BrowserAxNode[] = [],
    frameId?: string,
  ): { node: BrowserAxNode; ancestors: readonly BrowserAxNode[]; frameId: string | undefined }[] =>
    nodes.flatMap((node) => {
      const frame = node.frameId ?? frameId;
      return [
        { node, ancestors, frameId: frame },
        ...visit(node.children ?? [], [...ancestors, node], frame),
      ];
    });
  return visit(snapshot.nodes);
}

function properties(node: BrowserAxNode | undefined) {
  // Focus movement alone does not change the proposed value or field meaning.
  // The native driver still checks geometry, focusability and action scope.
  return Object.fromEntries(
    Object.entries(node?.properties ?? {})
      .filter(([key]) => key !== "focused")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Capture only the current action's observed dependencies, never the whole page text.
 * An incomplete observation is explicitly non-reusable. Callers must re-observe
 * or escalate; a matching fingerprint never replaces the native dispatch guard.
 */
export function captureActionDependencies(
  snapshot: GoalSnapshot,
  target: BrowserElementRef,
  relatedIdentities: readonly string[] = [],
): ActionDependencies {
  const targetIdentity = taskControlIdentity(target);
  const related = [...new Set(relatedIdentities.filter((id) => id !== targetIdentity))].sort();
  const reasons: string[] = [];
  if (!snapshot.documentId) reasons.push("missing_document_identity");
  if (target.backendNodeId === undefined) reasons.push("missing_target_backend_identity");
  if (snapshot.truncated) reasons.push("truncated_control_observation");
  if (snapshot.pageTextTruncated) reasons.push("truncated_validation_text");
  const entries = nodeEntries(snapshot);
  const selectedRefs: BrowserElementRef[] = [];
  const hiddenDependencies = new Map<
    string,
    NonNullable<GoalSnapshot["dependencyControls"]>[string]
  >();
  for (const identity of [targetIdentity, ...related]) {
    const matches = snapshot.refs.filter((ref) => taskControlIdentity(ref) === identity);
    const ref = matches[0];
    if (matches.length !== 1 || !ref || ref.backendNodeId === undefined) {
      const hidden =
        identity !== targetIdentity && matches.length === 0
          ? snapshot.dependencyControls?.[identity]
          : undefined;
      if (
        hidden &&
        taskControlIdentity(hidden.ref) === identity &&
        hidden.ref.backendNodeId !== undefined &&
        hidden.control.domSemantics &&
        !["hidden", "unavailable"].includes(hidden.control.availability)
      ) {
        hiddenDependencies.set(identity, hidden);
      } else reasons.push(`unresolved_control:${identity}`);
    } else {
      selectedRefs.push(ref);
    }
  }
  const targetRef = selectedRefs.find((ref) => taskControlIdentity(ref) === targetIdentity);
  // The target supplied by the decision must still describe the captured observation.
  if (targetRef && (targetRef.role !== target.role || targetRef.name !== target.name)) {
    reasons.push("target_semantics_mismatch");
  }
  const elementNode = (ref: BrowserElementRef) =>
    entries.find(
      ({ node, frameId }) =>
        node.ref === ref.ref ||
        (node.backendNodeId === ref.backendNodeId && frameId === ref.frameId),
    );
  const serializeRef = (ref: BrowserElementRef) => {
    const entry = elementNode(ref);
    const control = snapshot.controls?.[ref.ref];
    if (!entry) reasons.push(`missing_ax_semantics:${taskControlIdentity(ref)}`);
    if (snapshot.controls && !control) {
      reasons.push(`missing_control_inspection:${taskControlIdentity(ref)}`);
    }
    if (control?.optionsTruncated) {
      reasons.push(`truncated_options:${taskControlIdentity(ref)}`);
    }
    return {
      identity: taskControlIdentity(ref),
      role: ref.role,
      name: ref.name,
      disabled: ref.disabled,
      context: ref.context,
      value: entry?.node.value,
      description: entry?.node.description,
      ignored: entry?.node.ignored,
      properties: properties(entry?.node),
      control: control ? semanticGoalControl(control) : undefined,
    };
  };

  // Peers in the same observed popup are relevant candidates, even if the model
  // chose only one of them. Ordinary unrelated controls are deliberately absent.
  const layerKeys = new Set(
    selectedRefs.flatMap((ref) => {
      const layerKey = snapshot.controls?.[ref.ref]?.layerKey;
      return layerKey ? [JSON.stringify([ref.frameId, layerKey])] : [];
    }),
  );
  const layerPeers = snapshot.refs.filter((ref) => {
    const layerKey = snapshot.controls?.[ref.ref]?.layerKey;
    return layerKey && layerKeys.has(JSON.stringify([ref.frameId, layerKey]));
  });
  const dependencies = [
    ...new Map(
      [...selectedRefs, ...layerPeers].map((ref) => [taskControlIdentity(ref), ref]),
    ).values(),
  ].sort((left, right) => taskControlIdentity(left).localeCompare(taskControlIdentity(right)));
  const dependencyEntries = dependencies.flatMap((ref) => {
    const entry = elementNode(ref);
    return entry ? [entry] : [];
  });
  const frameIds = new Set(dependencies.map((ref) => ref.frameId));
  const scopes = new Set(
    dependencyEntries.flatMap(({ ancestors }) =>
      ancestors.filter((node) => scopeRoles.has(node.role.toLowerCase())),
    ),
  );
  const namedScopes = new Set(
    dependencies.flatMap((ref) =>
      [ref.context?.form, ref.context?.dialog].filter((value): value is string => Boolean(value)),
    ),
  );
  const validation = entries
    .filter(({ node, frameId, ancestors }) => {
      if (node.ignored || !frameIds.has(frameId)) return false;
      const role = node.role.toLowerCase();
      if (role !== "alert" && role !== "status") return false;
      const ownScopes = ancestors.filter((ancestor) => scopeRoles.has(ancestor.role.toLowerCase()));
      const associated = ownScopes.some(
        (ancestor) => scopes.has(ancestor) || (ancestor.name && namedScopes.has(ancestor.name)),
      );
      // Unscoped alerts may be global validation errors. Unscoped status text
      // may be a clock; do not treat it as a field dependency without a relation.
      return associated || (role === "alert" && ownScopes.length === 0);
    })
    .map(({ node, frameId }) => ({
      frameId,
      role: node.role,
      name: node.name,
      value: node.value,
      description: node.description,
      properties: properties(node),
      // Error messages often expose their text as children rather than name.
      text: nodeText(node),
    }));
  const frameDocuments = entries
    .filter(
      ({ node, frameId }) =>
        frameIds.has(frameId) && ["rootwebarea", "document"].includes(node.role.toLowerCase()),
    )
    .map(({ node, frameId }) => ({
      frameId,
      backendNodeId: node.backendNodeId,
      value: node.value,
      properties: properties(node),
    }));
  const serialized = [
    ...dependencies.map(serializeRef),
    ...[...hiddenDependencies].map(([identity, { ref, control }]) => ({
      identity,
      frameId: ref.frameId,
      evidence: "live-dom-modal-dependency",
      control: semanticGoalControl(control),
    })),
  ];
  const notedCoverageWarnings: string[] = [];
  for (const warning of snapshot.coverageWarnings ?? []) {
    if (
      warning === "iframe_coverage_is_best_effort_oopif_may_be_missing" &&
      selectedRefs.length + hiddenDependencies.size === related.length + 1 &&
      reasons.length === 0 &&
      [...hiddenDependencies.values()].every(
        ({ ref, control }) => ref.frameId && control.availability !== "unavailable",
      ) &&
      dependencies.every(
        (ref) =>
          ref.frameId &&
          ref.backendNodeId !== undefined &&
          snapshot.controls?.[ref.ref] &&
          snapshot.controls[ref.ref]?.availability !== "unavailable",
      )
    ) {
      // The adapter always emits this warning for iframe-capable snapshots.
      // It limits whole-page completeness, but does not erase a successfully
      // inspected target's explicit frame/backend identity. Preserve the warning
      // for callers instead of blocking every local action on these pages.
      notedCoverageWarnings.push(warning);
    } else {
      reasons.push(`coverage:${warning}`);
    }
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ controls: serialized, validation, frameDocuments }))
    .digest("hex");
  return {
    documentId: snapshot.documentId ?? null,
    browserInstance: snapshot.browserInstance ?? null,
    pageId: snapshot.pageId ?? null,
    targetIdentity,
    relatedIdentities: related,
    reusable: reasons.length === 0,
    unavailableReasons: [...new Set(reasons)],
    notedCoverageWarnings,
    fingerprint,
  };
}

function nodeText(node: BrowserAxNode): string[] {
  if (node.ignored) return [];
  return [node.name ?? "", node.value ?? "", ...(node.children ?? []).flatMap(nodeText)];
}

export function actionDependenciesMatch(
  expected: ActionDependencies,
  fresh: GoalSnapshot,
): boolean {
  if (
    !expected.reusable ||
    expected.documentId !== (fresh.documentId ?? null) ||
    expected.browserInstance !== (fresh.browserInstance ?? null) ||
    expected.pageId !== (fresh.pageId ?? null)
  ) {
    return false;
  }
  const target = fresh.refs.find((ref) => taskControlIdentity(ref) === expected.targetIdentity);
  if (!target) return false;
  const actual = captureActionDependencies(fresh, target, expected.relatedIdentities);
  return actual.reusable && actual.fingerprint === expected.fingerprint;
}

export const FormCompletionDependenciesSchema = z.object({
  documentId: z.string().nullable(),
  browserInstance: z.string().nullable(),
  pageId: z.string().nullable(),
  controlIdentities: z.array(z.string()),
  fieldCount: z.number().int().nonnegative(),
  reusable: z.boolean(),
  unavailableReasons: z.array(z.string()),
  notedCoverageWarnings: z.array(z.string()),
  fingerprint: z.string(),
});
export type FormCompletionDependencies = z.infer<typeof FormCompletionDependenciesSchema>;

const documentRoles = new Set(["rootwebarea", "document", "iframe"]);
const staticTextRoles = new Set(["statictext", "inlinetextbox"]);
const formFieldRoles = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "checkbox",
  "radio",
  "radiogroup",
  "switch",
  "slider",
  "menuitemcheckbox",
  "menuitemradio",
]);

/** For a prepared form's final review only. This is an observation-change guard,
 * not a completion oracle. Preserve every observed control and AX/context error;
 * exclude only the independent pageText blob, which mixes unrelated clocks with
 * page content. Non-form or incomplete observations must use the caller's global
 * fallback. In particular, this cannot certify text absent from AX/DOM metadata.
 */
export function captureFormCompletionDependencies(
  snapshot: GoalSnapshot,
): FormCompletionDependencies {
  const reasons: string[] = [];
  if (!snapshot.documentId) reasons.push("missing_document_identity");
  if (snapshot.truncated) reasons.push("truncated_control_observation");
  if (snapshot.pageTextTruncated) reasons.push("truncated_validation_text");
  const entries = nodeEntries(snapshot);
  const staticRefs = snapshot.refs.filter((ref) => staticTextRoles.has(ref.role.toLowerCase()));
  const refs = snapshot.refs
    .filter(
      (ref) =>
        !documentRoles.has(ref.role.toLowerCase()) && !staticTextRoles.has(ref.role.toLowerCase()),
    )
    .sort((left, right) => taskControlIdentity(left).localeCompare(taskControlIdentity(right)));
  const identities = refs.map(taskControlIdentity);
  if (new Set(identities).size !== identities.length) reasons.push("ambiguous_control_identity");
  const fieldCount = refs.filter((ref) => {
    const control = snapshot.controls?.[ref.ref];
    return (
      formFieldRoles.has(ref.role.toLowerCase()) ||
      control?.editable ||
      control?.nativeSelect ||
      Boolean(ref.context?.form)
    );
  }).length;
  if (fieldCount === 0) reasons.push("no_observed_form_fields");
  const controls = refs.map((ref) => {
    const identity = taskControlIdentity(ref);
    if (ref.backendNodeId === undefined) reasons.push(`missing_backend_identity:${identity}`);
    const entry = entries.find(
      ({ node, frameId }) =>
        node.ref === ref.ref ||
        (node.backendNodeId === ref.backendNodeId && frameId === ref.frameId),
    );
    const control = snapshot.controls?.[ref.ref];
    if (!entry) reasons.push(`missing_ax_semantics:${identity}`);
    if (!control || control.availability === "unavailable") {
      reasons.push(`missing_control_inspection:${identity}`);
    }
    if (control?.optionsTruncated) reasons.push(`truncated_options:${identity}`);
    return {
      identity,
      role: ref.role,
      name: ref.name,
      disabled: ref.disabled,
      context: ref.context,
      value: entry?.node.value,
      description: entry?.node.description,
      ignored: entry?.node.ignored,
      properties: properties(entry?.node),
      // Includes field labels, errors, checked/selected options, ARIA relations,
      // required/input type, availability and popup/expanded state without pruning.
      control: control ? semanticGoalControl(control) : undefined,
    };
  });
  const notedCoverageWarnings: string[] = [];
  const rootDocumentObserved =
    Boolean(snapshot.documentId) &&
    entries.some(
      ({ node, frameId }) =>
        frameId === undefined &&
        ["rootwebarea", "document"].includes(node.role.toLowerCase()) &&
        node.backendNodeId !== undefined,
    );
  const framesBound = refs.every((ref) => {
    if (ref.frameId) return true;
    const entry = entries.find(({ node }) => node.ref === ref.ref);
    // The AX adapter intentionally omits frameId for the main document. Bind
    // that case to the observed root backend/document identity, never to an
    // arbitrary iframe whose inherited frame identity was lost from its ref.
    return rootDocumentObserved && entry !== undefined && entry.frameId === undefined;
  });
  for (const warning of snapshot.coverageWarnings ?? []) {
    if (
      warning === "iframe_coverage_is_best_effort_oopif_may_be_missing" &&
      reasons.length === 0 &&
      framesBound
    ) {
      notedCoverageWarnings.push(warning);
    } else {
      reasons.push(`coverage:${warning}`);
    }
  }
  const refIds = new Set(snapshot.refs.map((ref) => ref.ref));
  if (entries.some(({ node }) => node.ref && !refIds.has(node.ref))) {
    reasons.push("unbound_ax_reference");
  }
  for (const ref of staticRefs) {
    if (
      !entries.some(
        ({ node }) => node.ref === ref.ref && staticTextRoles.has(node.role.toLowerCase()),
      )
    ) {
      reasons.push(`missing_static_ax_semantics:${taskControlIdentity(ref)}`);
    }
  }
  const staticSemantics = entries
    .filter(
      ({ node }) =>
        !node.ref ||
        documentRoles.has(node.role.toLowerCase()) ||
        staticTextRoles.has(node.role.toLowerCase()),
    )
    .map(({ node, frameId }) => ({
      frameId,
      role: node.role,
      name: node.name,
      value: node.value,
      description: node.description,
      ignored: node.ignored,
      properties: properties(node),
      ...(documentRoles.has(node.role.toLowerCase()) ? { backendNodeId: node.backendNodeId } : {}),
    }));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        documentId: snapshot.documentId,
        browserInstance: snapshot.browserInstance,
        pageId: snapshot.pageId,
        scope: snapshot.scope,
        interactiveOnly: snapshot.interactiveOnly,
        controls,
        // AX text nodes may carry refs/backend IDs but are not DOM Elements, so
        // an unavailable element inspector is expected. Keep their identity and
        // all accessible text instead of requiring control geometry/validity.
        staticRefs: staticRefs.map((ref) => ({
          identity: taskControlIdentity(ref),
          role: ref.role,
          name: ref.name,
          disabled: ref.disabled,
          context: ref.context,
        })),
        staticSemantics,
        coverageWarnings: [...(snapshot.coverageWarnings ?? [])].sort(),
      }),
    )
    .digest("hex");
  return {
    documentId: snapshot.documentId ?? null,
    browserInstance: snapshot.browserInstance ?? null,
    pageId: snapshot.pageId ?? null,
    controlIdentities: identities,
    fieldCount,
    reusable: reasons.length === 0,
    unavailableReasons: [...new Set(reasons)],
    notedCoverageWarnings,
    fingerprint,
  };
}

export function formCompletionDependenciesMatch(
  expected: FormCompletionDependencies,
  fresh: GoalSnapshot,
): boolean {
  if (!expected.reusable) return false;
  const actual = captureFormCompletionDependencies(fresh);
  return actual.reusable && actual.fingerprint === expected.fingerprint;
}
