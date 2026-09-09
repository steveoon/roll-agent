import type { NativeCdpController, NativeCdpFrameTree } from "../runtime/native-cdp-controller.ts";
import { BrowserScriptError, normalizeBrowserOrigin } from "./contracts.ts";

type FrameController = Pick<
  NativeCdpController,
  "getDocument" | "resolveBackendNode" | "callFunctionOnObject" | "releaseObject"
>;

// Fixed host source. Coordinates are CDP's main viewport coordinates, never child-local ones.
export const INSPECT_FRAME_ANCESTORS = `function(point, allowedOrigins, requireFocus) {
  try {
    const frames = [];
    let view = this.defaultView;
    if (!view || view.document !== this) return 'coverage_gap';
    while (view !== view.top) {
      if (frames.length >= 32) return 'coverage_gap';
      const owner = view.frameElement;
      if (!owner || owner.contentDocument !== view.document) return 'coverage_gap';
      if (!allowedOrigins.includes(view.location.origin)) return 'origin_not_allowed';
      frames.push(owner);
      view = owner.ownerDocument.defaultView;
      if (!view) return 'coverage_gap';
    }
    if (!allowedOrigins.includes(view.location.origin)) return 'origin_not_allowed';
    let x = point.x;
    let y = point.y;
    for (const owner of frames.reverse()) {
      const doc = owner.ownerDocument;
      const win = doc.defaultView;
      if (!owner.isConnected || !win) return 'stale_target';
      if (requireFocus) {
        let active = doc.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        if (active !== owner) return 'focus_changed';
      }
      for (let ancestor = owner; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
        const style = win.getComputedStyle(ancestor);
        if (style.transform !== 'none' || (style.perspective && style.perspective !== 'none') ||
            (style.translate && style.translate !== 'none') || (style.rotate && style.rotate !== 'none') ||
            (style.scale && style.scale !== 'none') || (style.zoom && Number(style.zoom) !== 1)) return 'coverage_gap';
        if (ancestor.inert || style.display === 'none' || style.visibility !== 'visible' ||
            Number(style.opacity) === 0) return 'target_obscured';
      }
      const rect = owner.getBoundingClientRect();
      if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight ||
          x < rect.left + owner.clientLeft || y < rect.top + owner.clientTop ||
          x >= rect.left + owner.clientLeft + owner.clientWidth ||
          y >= rect.top + owner.clientTop + owner.clientHeight) return 'target_obscured';
      let hit = doc.elementFromPoint(x, y);
      // Descend open shadow roots; a closed root fails closed because hit remains its host.
      while (hit && hit.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      if (hit !== owner) return 'target_obscured';
      x -= rect.left + owner.clientLeft;
      y -= rect.top + owner.clientTop;
    }
    return 'clear';
  } catch { return 'coverage_gap'; }
}`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function framePath(tree: NativeCdpFrameTree, id: string): NativeCdpFrameTree[] | undefined {
  if (tree.frame.id === id) return [tree];
  for (const child of tree.childFrames ?? []) {
    const path = framePath(child, id);
    if (path) return [tree, ...path];
  }
  return undefined;
}

function frameDocumentBackendId(value: unknown, frameId: string): number | undefined {
  const pending = [value];
  let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const node = pending.pop();
    if (!record(node)) continue;
    const document = node.contentDocument;
    if (
      record(document) &&
      (node.frameId === frameId || document.frameId === frameId) &&
      typeof document.backendNodeId === "number"
    ) {
      return document.backendNodeId;
    }
    for (const key of ["root", "contentDocument"]) {
      if (record(node[key])) pending.push(node[key]);
    }
    for (const key of ["children", "shadowRoots"]) {
      const children = node[key];
      if (Array.isArray(children)) pending.push(...children);
    }
  }
  return undefined;
}

/** Reject input into an iframe if any ancestor viewport would receive it elsewhere. */
export async function assertFramePointUnoccluded(
  controller: FrameController,
  input: {
    frameId: string;
    tree: NativeCdpFrameTree;
    point: { x: number; y: number };
    allowedOrigins: readonly string[];
    requireFocus?: boolean;
    guard: () => Promise<void>;
  },
): Promise<void> {
  await input.guard();
  if (!Number.isFinite(input.point.x) || !Number.isFinite(input.point.y)) {
    throw new BrowserScriptError("target_obscured", "Invalid outgoing pointer coordinates.");
  }
  if (input.frameId === input.tree.frame.id) return;
  const path = framePath(input.tree, input.frameId);
  if (!path) throw new BrowserScriptError("stale_target", "The target frame no longer exists.");
  const origins = path.map(({ frame }) => {
    try {
      return normalizeBrowserOrigin(frame.url);
    } catch {
      throw new BrowserScriptError(
        "coverage_gap",
        "A frame ancestor has no inspectable HTTP origin.",
      );
    }
  });
  if (origins.some((origin) => !input.allowedOrigins.includes(origin))) {
    throw new BrowserScriptError(
      "origin_not_allowed",
      "A frame ancestor is outside allowed origins.",
    );
  }
  if (new Set(origins).size !== 1) {
    throw new BrowserScriptError("coverage_gap", "Cross-origin frame hit testing is unavailable.");
  }
  const document = await controller.getDocument({ depth: -1, pierce: true });
  await input.guard();
  const backendNodeId = frameDocumentBackendId(document, input.frameId);
  if (backendNodeId === undefined) {
    throw new BrowserScriptError("coverage_gap", "Cannot inspect the target frame document.");
  }
  const objectId = await controller.resolveBackendNode({ backendNodeId });
  try {
    await input.guard();
    const result = await controller.callFunctionOnObject({
      objectId,
      functionDeclaration: INSPECT_FRAME_ANCESTORS,
      args: [input.point, input.allowedOrigins, input.requireFocus ?? false],
    });
    await input.guard();
    if (result !== "clear") {
      const code =
        result === "target_obscured" ||
        result === "stale_target" ||
        result === "origin_not_allowed" ||
        result === "focus_changed"
          ? result
          : "coverage_gap";
      throw new BrowserScriptError(
        code,
        "The frame ancestor chain cannot receive this pointer action.",
      );
    }
  } finally {
    await controller.releaseObject(objectId).catch(() => {});
  }
  await input.guard();
}
