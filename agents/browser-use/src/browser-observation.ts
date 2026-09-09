import {
  type BrowserAxNode,
  type BrowserAxSnapshot,
  type NativeCdpController,
  createBrowserAxSnapshot,
  enrichBrowserSnapshot,
  readBrowserDocumentIdentity,
  resolveBrowserSnapshotScope,
} from "@roll-agent/browser";
import { collectDomActionHints } from "./tools/browser-dom-action-candidates.ts";
import { browserElementRefStore } from "./element-ref-store.ts";
export { readBrowserDocumentIdentity } from "@roll-agent/browser";
type IframeSnapshotTarget = {
  readonly node: BrowserAxNode;
  readonly frameId: string;
};

type IframeSnapshot = {
  readonly iframeRef: string;
  readonly snapshot: BrowserAxSnapshot;
};

type IframeSnapshotController = Pick<
  NativeCdpController,
  | "createIsolatedWorld"
  | "describeNode"
  | "evaluateJson"
  | "getDocument"
  | "getFullAccessibilityTree"
  | "querySelectorAllByNodeId"
>;

function collectIframeNodes(nodes: readonly BrowserAxNode[]): readonly BrowserAxNode[] {
  const output: BrowserAxNode[] = [];
  const visit = (node: BrowserAxNode): void => {
    if (node.role.toLowerCase() === "iframe" && node.backendNodeId !== undefined) {
      output.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }
  return output;
}

async function resolveIframeFrameId(
  controller: IframeSnapshotController,
  node: BrowserAxNode,
): Promise<string | undefined> {
  if (node.backendNodeId === undefined) {
    return undefined;
  }

  const domNode = await controller
    .describeNode({
      backendNodeId: node.backendNodeId,
      depth: 1,
    })
    .catch(() => undefined);
  return domNode?.contentDocumentFrameId ?? domNode?.frameId;
}

async function collectIframeSnapshotTargets(
  controller: IframeSnapshotController,
  nodes: readonly BrowserAxNode[],
): Promise<readonly IframeSnapshotTarget[]> {
  const iframeNodes = collectIframeNodes(nodes);
  const resolved = await Promise.all(
    iframeNodes.map(async (node) => {
      const frameId = await resolveIframeFrameId(controller, node);
      return frameId === undefined ? undefined : { node, frameId };
    }),
  );
  return resolved.filter((target): target is IframeSnapshotTarget => target !== undefined);
}

function parseElementRefNumber(ref: string): number {
  const parsed = Number.parseInt(ref.slice(2), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextRefCount(snapshot: BrowserAxSnapshot): number {
  return snapshot.refs.reduce((max, ref) => Math.max(max, parseElementRefNumber(ref.ref)), 0);
}

function inlineFlatIframeSnapshots(
  nodes: readonly BrowserAxNode[],
  childSnapshotsByRef: ReadonlyMap<string, BrowserAxSnapshot>,
): BrowserAxNode[] {
  return nodes.flatMap((node) => {
    const childSnapshot = node.ref === undefined ? undefined : childSnapshotsByRef.get(node.ref);
    if (childSnapshot === undefined) {
      return [node];
    }

    return [node, ...inlineFlatIframeSnapshots(childSnapshot.nodes, childSnapshotsByRef)];
  });
}

function inlineTreeIframeSnapshots(
  nodes: readonly BrowserAxNode[],
  childSnapshotsByRef: ReadonlyMap<string, BrowserAxSnapshot>,
): BrowserAxNode[] {
  return nodes.map((node) => {
    const childSnapshot = node.ref === undefined ? undefined : childSnapshotsByRef.get(node.ref);
    const existingChildren = node.children ?? [];
    const nestedChildren = inlineTreeIframeSnapshots(existingChildren, childSnapshotsByRef);
    const iframeChildren =
      childSnapshot === undefined
        ? []
        : inlineTreeIframeSnapshots(childSnapshot.nodes, childSnapshotsByRef);
    const children =
      childSnapshot === undefined ? nestedChildren : [...nestedChildren, ...iframeChildren];

    return children.length === 0 ? node : { ...node, children };
  });
}

async function inlineIframeSnapshots(input: {
  readonly controller: IframeSnapshotController;
  readonly snapshot: BrowserAxSnapshot;
  readonly maxDepth?: number;
}): Promise<BrowserAxSnapshot> {
  let refCount = nextRefCount(input.snapshot);
  let remainingNodes = Math.max(0, input.snapshot.maxNodes - input.snapshot.nodeCount);
  let truncated = input.snapshot.truncated;
  const visitedFrameIds = new Set<string>();
  const childSnapshots: IframeSnapshot[] = [];
  const pendingTargets = [
    ...(await collectIframeSnapshotTargets(input.controller, input.snapshot.nodes)),
  ];

  for (let index = 0; index < pendingTargets.length; index += 1) {
    const target = pendingTargets[index];
    if (target === undefined) {
      continue;
    }
    if (remainingNodes <= 0) {
      truncated = true;
      break;
    }
    if (target.node.ref === undefined || visitedFrameIds.has(target.frameId)) {
      continue;
    }
    visitedFrameIds.add(target.frameId);

    const childDomActionHints = await collectDomActionHints(input.controller, {
      frameId: target.frameId,
      maxCandidates: remainingNodes,
    }).catch(() => []);
    const childSnapshot = await createBrowserAxSnapshot(input.controller, {
      depthOffset: target.node.depth + 1,
      domActionHints: childDomActionHints,
      frameId: target.frameId,
      initialRefCount: refCount,
      interactiveOnly: input.snapshot.interactiveOnly,
      maxNodes: remainingNodes,
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    }).catch(() => undefined);

    if (
      childSnapshot === undefined ||
      childSnapshot.nodeCount === 0 ||
      childSnapshot.refs.length === 0
    ) {
      continue;
    }

    const nestedTargets = await collectIframeSnapshotTargets(input.controller, childSnapshot.nodes);
    childSnapshots.push({
      iframeRef: target.node.ref,
      snapshot: childSnapshot,
    });
    pendingTargets.push(...nestedTargets);
    refCount = nextRefCount(childSnapshot);
    remainingNodes = Math.max(0, remainingNodes - childSnapshot.nodeCount);
    truncated = truncated || childSnapshot.truncated;
  }

  if (childSnapshots.length === 0) {
    return {
      ...input.snapshot,
      truncated,
    };
  }

  const childSnapshotsByRef = new Map(
    childSnapshots.map((child) => [child.iframeRef, child.snapshot]),
  );
  const childRefs = childSnapshots.flatMap((child) => child.snapshot.refs);
  const childNodeCount = childSnapshots.reduce(
    (count, child) => count + child.snapshot.nodeCount,
    0,
  );

  return {
    ...input.snapshot,
    nodes: input.snapshot.interactiveOnly
      ? inlineFlatIframeSnapshots(input.snapshot.nodes, childSnapshotsByRef)
      : inlineTreeIframeSnapshots(input.snapshot.nodes, childSnapshotsByRef),
    refs: [...input.snapshot.refs, ...childRefs],
    nodeCount: input.snapshot.nodeCount + childNodeCount,
    truncated,
  };
}

export async function observeBrowserPage(input: {
  readonly controller: NativeCdpController;
  readonly page: { readonly targetId: string };
  readonly browserInstance: string;
  readonly scope?: string;
  readonly allowedOrigins?: readonly string[];
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly interactiveOnly?: boolean;
}): Promise<BrowserAxSnapshot> {
  const documentId = await readBrowserDocumentIdentity(input.controller);
  const scope =
    input.scope === undefined
      ? undefined
      : await resolveBrowserSnapshotScope({
          controller: input.controller,
          scope: input.scope,
          includeFrameDocuments: input.allowedOrigins === undefined,
        });
  const domActionHints = await collectDomActionHints(input.controller, {
    maxCandidates: input.maxNodes ?? 500,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
  const rootSnapshot = await createBrowserAxSnapshot(input.controller, {
    domActionHints,
    ...(scope === undefined ? {} : { backendNodeIds: scope.backendNodeIds }),
    interactiveOnly: input.interactiveOnly ?? true,
    maxNodes: input.maxNodes ?? 500,
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
  });
  const snapshot =
    input.allowedOrigins !== undefined
      ? {
          ...rootSnapshot,
          coverageWarnings: ["iframe_expansion_disabled_for_origin_bounded_execution"],
        }
      : await inlineIframeSnapshots({
          controller: input.controller,
          snapshot: rootSnapshot,
          ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        });
  const enriched = await enrichBrowserSnapshot({
    controller: input.controller,
    snapshot,
    browserInstance: input.browserInstance,
    pageId: input.page.targetId,
    includeFrameDocuments: input.allowedOrigins === undefined,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });
  if (
    enriched.documentId !== documentId ||
    (await readBrowserDocumentIdentity(input.controller)) !== documentId
  ) {
    throw new Error("Document changed while observing. Take a new snapshot.");
  }
  browserElementRefStore.saveSnapshot(input.page.targetId, enriched);
  return enriched;
}
