import { defineTool } from "@roll-agent/sdk";
import {
  type BrowserAxNode,
  BrowserAxSnapshotSchema,
  type BrowserAxSnapshot,
  type NativeCdpController,
  BrowserPageInfoSchema,
  createBrowserAxSnapshot,
} from "@roll-agent/browser";
import { z } from "zod";
import { browserElementRefStore } from "../element-ref-store.ts";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { toNativePageInfo } from "../page-info.ts";
import { resolveNativePageForBrowserTool } from "./browser-native-page.ts";
import { collectDomActionHints } from "./browser-dom-action-candidates.ts";
import { createBrowserRefVisualSession } from "./browser-ref-visual.ts";

const BrowserSnapshotInputSchema = z.object({
  pageId: z.string().optional().describe("可选：通过 list_pages 返回的 pageId/native targetId"),
  maxDepth: z.number().int().nonnegative().optional().describe("可选：限制 AX Tree 深度"),
  maxNodes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("可选：返回节点上限；实际值不会超过 Browser security maxSnapshotNodes"),
  interactiveOnly: z.boolean().default(true).describe("默认 true：只返回可交互节点"),
});

const BrowserSnapshotOutputSchema = z.object({
  page: BrowserPageInfoSchema,
  snapshot: BrowserAxSnapshotSchema,
});

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
  "describeNode" | "getFullAccessibilityTree"
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

    const childSnapshot = await createBrowserAxSnapshot(input.controller, {
      depthOffset: target.node.depth + 1,
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

export const browserSnapshot = defineTool({
  name: "browser_snapshot",
  description:
    "读取当前或指定页面的 Accessibility Tree，并为可交互节点生成 @eN ref；默认只返回可交互节点。",
  input: BrowserSnapshotInputSchema,
  output: BrowserSnapshotOutputSchema,
  execute: async (input, ctx) => {
    const runtime = getRuntime();
    const ctxManager = getContextManager();
    const page = await resolveNativePageForBrowserTool({
      runtime,
      ctxManager,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    });

    ctx.logger.info(`Creating browser AX snapshot for page ${page.targetId}`);
    const controller = await runtime.connectNativePage(page);
    const session = createBrowserRefVisualSession(controller);
    try {
      await session.begin("正在读取页面快照");
      const security = runtime.getConfig().security;
      const effectiveMaxNodes = Math.min(
        input.maxNodes ?? security.maxSnapshotNodes,
        security.maxSnapshotNodes,
      );
      const domActionHints = await collectDomActionHints(controller, effectiveMaxNodes);
      const rootSnapshot = await createBrowserAxSnapshot(controller, {
        domActionHints,
        interactiveOnly: input.interactiveOnly ?? true,
        maxNodes: effectiveMaxNodes,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      });
      const snapshot = await inlineIframeSnapshots({
        controller,
        snapshot: rootSnapshot,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      });
      browserElementRefStore.saveSnapshot(page.targetId, snapshot);
      await session.succeed(`已识别 ${snapshot.refs.length} 个可操作元素`);

      return {
        page: toNativePageInfo(ctxManager, page),
        snapshot,
      };
    } catch (error) {
      await session.fail("读取页面快照失败");
      throw error;
    } finally {
      controller.close();
    }
  },
});
