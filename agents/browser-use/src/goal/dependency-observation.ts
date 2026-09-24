import type { BrowserElementRef, NativeCdpController } from "@roll-agent/browser";
import { inspectGoalControls } from "./observation.ts";
import type { GoalDependencyControl, GoalSnapshot } from "./observation.ts";
import { taskControlIdentity, taskNodes } from "./task-policy.ts";

/** Retain handles only for read-only dependency inspection, never AX resurrection.
 * A replaced/disconnected node, document change or missing modal fails closed.
 */
export function createDependencyObserver(
  controller: Parameters<typeof inspectGoalControls>[0] & Pick<NativeCdpController, "getFrameTree">,
  origins: readonly string[],
  signal: AbortSignal,
) {
  let documentId: string | undefined;
  const knownRefs = new Map<string, BrowserElementRef>();
  return async (
    snapshot: GoalSnapshot,
    identities: readonly string[] = [],
  ): Promise<GoalSnapshot> => {
    if (!snapshot.documentId || documentId !== snapshot.documentId) knownRefs.clear();
    documentId = snapshot.documentId;
    for (const ref of snapshot.refs) knownRefs.set(taskControlIdentity(ref), ref);
    // Bound task-local retention even on pages with continual node replacement.
    while (knownRefs.size > 512) knownRefs.delete(knownRefs.keys().next().value!);
    const modal = taskNodes(snapshot.nodes).some(
      (node) =>
        ["dialog", "alertdialog"].includes(node.role.toLowerCase()) &&
        node.properties?.modal === true,
    );
    if (!modal || !snapshot.documentId || !identities.length) return snapshot;
    const visible = new Set(snapshot.refs.map(taskControlIdentity));
    const refs = [...new Set(identities)].slice(0, 32).flatMap((identity) => {
      const ref = knownRefs.get(identity);
      return !visible.has(identity) && ref?.backendNodeId !== undefined ? [ref] : [];
    });
    if (!refs.length) return snapshot;
    const tree = await controller.getFrameTree();
    const permitted = new Set<string>();
    const visit = (node: typeof tree): void => {
      try {
        if (!origins.includes(new URL(node.frame.url).origin)) return;
      } catch {
        return;
      }
      permitted.add(node.frame.id);
      for (const child of node.childFrames ?? []) visit(child);
    };
    visit(tree);
    const scoped = refs.filter((ref) => permitted.has(ref.frameId ?? tree.frame.id));
    const inspected = await inspectGoalControls(
      controller,
      { ...snapshot, refs: scoped },
      origins,
      signal,
    );
    const dependencyControls: Record<string, GoalDependencyControl> = {};
    for (const ref of scoped) {
      const control = inspected.controls?.[ref.ref];
      if (control?.domSemantics && !["hidden", "unavailable"].includes(control.availability)) {
        dependencyControls[taskControlIdentity(ref)] = { ref, control };
      }
    }
    return { ...snapshot, dependencyControls };
  };
}
