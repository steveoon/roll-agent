import { randomUUID } from "node:crypto";
import type { BrowserAxNode, BrowserAxSnapshot, BrowserElementRef } from "../types/index.ts";
import type { NativeCdpController, NativeCdpFrame } from "./native-cdp-controller.ts";

type ObservationController = Pick<
  NativeCdpController,
  "getDocument" | "getFrameTree" | "querySelectorAllByNodeId"
>;
type DomEntry = {
  readonly nodeId: number;
  readonly backendNodeId: number;
  readonly tag: string;
  readonly text: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly parent?: DomEntry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentRoot(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value["root"])) {
    throw new Error("Cannot identify browser document.");
  }
  return value["root"];
}

function identity(root: Record<string, unknown>, frame: NativeCdpFrame): string {
  const id = root["backendNodeId"];
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error("Cannot identify browser document backend node.");
  }
  if (!frame.id || !frame.loaderId) throw new Error("Cannot identify browser document loader.");
  return JSON.stringify([frame.id, frame.loaderId, id]);
}

export async function readBrowserDocumentIdentity(
  controller: Pick<NativeCdpController, "getDocument" | "getFrameTree">,
): Promise<string> {
  const root = documentRoot(await controller.getDocument({ depth: 0 }));
  return identity(root, (await controller.getFrameTree()).frame);
}

function collectEntries(
  root: Record<string, unknown>,
  includeFrameDocuments = true,
): { entries: DomEntry[]; truncated: boolean } {
  const entries: DomEntry[] = [];
  const pending: Array<{ node: Record<string, unknown>; parent?: DomEntry }> = [{ node: root }];
  let scanned = 0;
  while (pending.length > 0 && scanned < 10_000) {
    const item = pending.pop();
    if (item === undefined) break;
    scanned += 1;
    const attrs = new Map<string, string>();
    const rawAttrs = item.node["attributes"];
    if (Array.isArray(rawAttrs)) {
      for (let i = 0; i < rawAttrs.length; i += 2) {
        const key: unknown = rawAttrs[i];
        const value: unknown = rawAttrs[i + 1];
        if (typeof key === "string" && typeof value === "string") attrs.set(key, value);
      }
    }
    const nodeId = item.node["nodeId"];
    const backendNodeId = item.node["backendNodeId"];
    const entry: DomEntry = {
      nodeId: typeof nodeId === "number" ? nodeId : 0,
      backendNodeId: typeof backendNodeId === "number" ? backendNodeId : 0,
      tag: String(item.node["localName"] ?? item.node["nodeName"] ?? "").toLowerCase(),
      text: typeof item.node["nodeValue"] === "string" ? item.node["nodeValue"].slice(0, 160) : "",
      attributes: attrs,
      ...(item.parent !== undefined ? { parent: item.parent } : {}),
    };
    entries.push(entry);
    const children: unknown[] = [];
    for (const key of ["children", "shadowRoots"]) {
      const value = item.node[key];
      if (Array.isArray(value)) children.push(...value);
    }
    if (includeFrameDocuments && isRecord(item.node["contentDocument"])) {
      children.push(item.node["contentDocument"]);
    }
    for (const child of children.reverse()) {
      if (isRecord(child)) pending.push({ node: child, parent: entry });
    }
  }
  return { entries, truncated: pending.length > 0 };
}

function within(entry: DomEntry, scope: DomEntry): boolean {
  for (let current: DomEntry | undefined = entry; current !== undefined; current = current.parent) {
    if (current === scope) return true;
  }
  return false;
}

function enrichRef(
  ref: BrowserElementRef,
  entries: readonly DomEntry[],
  names: ReadonlyMap<number, string>,
): BrowserElementRef {
  const entry = entries.find((candidate) => candidate.backendNodeId === ref.backendNodeId);
  if (entry === undefined) return ref;
  const context: { form?: string; dialog?: string; label?: string } = {};
  const title = (node: DomEntry): string =>
    (
      names.get(node.backendNodeId) ||
      node.attributes.get("aria-label") ||
      (node.tag === "label"
        ? entries
            .filter((entry) => entry.text && within(entry, node))
            .map((entry) => entry.text)
            .join(" ")
            .trim()
        : "") ||
      node.attributes.get("name") ||
      node.attributes.get("id") ||
      node.tag
    ).slice(0, 160);
  for (let current: DomEntry | undefined = entry; current !== undefined; current = current.parent) {
    if (current.tag === "form" && context.form === undefined) context.form = title(current);
    if (
      (current.tag === "dialog" || current.attributes.get("role") === "dialog") &&
      context.dialog === undefined
    ) {
      context.dialog = title(current);
    }
    if (current.tag === "label" && context.label === undefined) context.label = title(current);
  }
  const labelIds = entry.attributes.get("aria-labelledby")?.split(/\s+/) ?? [];
  const id = entry.attributes.get("id");
  const label = entries.find(
    (candidate) =>
      (id !== undefined && candidate.tag === "label" && candidate.attributes.get("for") === id) ||
      labelIds.includes(candidate.attributes.get("id") ?? ""),
  );
  if (label !== undefined) context.label = title(label);
  const placeholder = entry.attributes.get("placeholder");
  if (context.label === undefined && placeholder) context.label = placeholder.slice(0, 160);
  return { ...ref, ...(Object.keys(context).length > 0 ? { context } : {}) };
}

async function scopedDocumentEntries(
  controller: ObservationController,
  root: Record<string, unknown>,
  scope: string,
  includeFrameDocuments: boolean,
): Promise<{ entries: DomEntry[]; scopedEntries: DomEntry[]; truncated: boolean }> {
  const nodeId = root["nodeId"];
  if (typeof nodeId !== "number") throw new Error("Cannot resolve observation scope.");
  const matches = await controller.querySelectorAllByNodeId({ nodeId, selector: scope });
  if (matches.length !== 1) throw new Error("Observation scope must match exactly one element.");
  // Locate the scope before allocating the bounded context scan; unrelated branches consume no output budget.
  const pending: Array<{ node: Record<string, unknown>; ancestors: Record<string, unknown>[] }> = [
    { node: root, ancestors: [] },
  ];
  let examined = 0;
  while (pending.length > 0 && examined < 100_000) {
    const item = pending.pop();
    if (!item) break;
    examined += 1;
    if (item.node["nodeId"] === matches[0]) {
      let branch = item.node;
      for (const ancestor of [...item.ancestors].reverse()) {
        branch = { ...ancestor, children: [branch], shadowRoots: [], contentDocument: undefined };
      }
      const result = collectEntries(branch, includeFrameDocuments);
      const scopeEntry = result.entries.find((entry) => entry.nodeId === matches[0]);
      if (!scopeEntry || result.truncated) {
        throw new Error("Observation scope exceeds supported DOM coverage.");
      }
      return {
        ...result,
        scopedEntries: result.entries.filter((entry) => within(entry, scopeEntry)),
      };
    }
    const children: unknown[] = [];
    for (const key of ["children", "shadowRoots"]) {
      const value = item.node[key];
      if (Array.isArray(value)) children.push(...value);
    }
    if (includeFrameDocuments && isRecord(item.node["contentDocument"])) {
      children.push(item.node["contentDocument"]);
    }
    for (const child of children.reverse()) {
      if (isRecord(child)) pending.push({ node: child, ancestors: [...item.ancestors, item.node] });
    }
  }
  throw new Error("Observation scope is outside supported DOM coverage.");
}

export async function resolveBrowserSnapshotScope(input: {
  readonly controller: ObservationController;
  readonly scope: string;
  readonly includeFrameDocuments?: boolean;
}): Promise<{ backendNodeIds: number[] }> {
  const includeFrames = input.includeFrameDocuments !== false;
  const root = documentRoot(
    await input.controller.getDocument({ depth: -1, pierce: includeFrames }),
  );
  const resolved = await scopedDocumentEntries(input.controller, root, input.scope, includeFrames);
  return {
    backendNodeIds: resolved.scopedEntries
      .map((entry) => entry.backendNodeId)
      .filter((id) => id > 0),
  };
}

/** Enrich without injecting markers or relying on page-owned JS globals. */
export async function enrichBrowserSnapshot(input: {
  readonly controller: ObservationController;
  readonly snapshot: BrowserAxSnapshot;
  readonly browserInstance: string;
  readonly pageId: string;
  readonly scope?: string;
  readonly includeFrameDocuments?: boolean;
}): Promise<BrowserAxSnapshot> {
  const root = documentRoot(
    await input.controller.getDocument({
      depth: -1,
      pierce: input.includeFrameDocuments !== false,
    }),
  );
  const documentId = identity(root, (await input.controller.getFrameTree()).frame);
  const context: { entries: DomEntry[]; scopedEntries?: DomEntry[]; truncated: boolean } =
    input.scope === undefined
      ? collectEntries(root, input.includeFrameDocuments !== false)
      : await scopedDocumentEntries(
          input.controller,
          root,
          input.scope,
          input.includeFrameDocuments !== false,
        );
  const { entries, truncated } = context;
  const scopedEntries = context.scopedEntries ?? entries;
  const rootId = root["nodeId"];
  const names = new Map<number, string>();
  const visit = (nodes: readonly BrowserAxNode[]): void => {
    for (const node of nodes) {
      if (node.backendNodeId !== undefined && node.name) names.set(node.backendNodeId, node.name);
      visit(node.children ?? []);
    }
  };
  visit(input.snapshot.nodes);
  const allowed = new Set(scopedEntries.map((entry) => entry.backendNodeId));
  const filterNodes = (nodes: readonly BrowserAxNode[]): BrowserAxNode[] =>
    nodes.flatMap((node) => {
      const children = filterNodes(node.children ?? []);
      if (
        input.scope !== undefined &&
        (node.backendNodeId === undefined || !allowed.has(node.backendNodeId))
      ) {
        return children;
      }
      return [{ ...node, ...(node.children !== undefined ? { children } : {}) }];
    });
  const refs = input.snapshot.refs
    .filter(
      (ref) =>
        input.scope === undefined ||
        (ref.backendNodeId !== undefined && allowed.has(ref.backendNodeId)),
    )
    .map((ref) =>
      enrichRef(input.scope === undefined ? ref : { ...ref, strict: true }, entries, names),
    );
  // Validate stable ID/test-id hints against the live DOM, never merely infer uniqueness from truncated AX output.
  const enriched: BrowserElementRef[] = [];
  for (const ref of refs) {
    const entry = scopedEntries.find((candidate) => candidate.backendNodeId === ref.backendNodeId);
    let css: string | undefined;
    if (entry !== undefined && typeof rootId === "number") {
      for (const attr of ["id", "data-testid"]) {
        const value = entry.attributes.get(attr);
        if (value === undefined || value.length > 200) continue;
        const candidate = `[${attr}=${JSON.stringify(value)}]`;
        const matches = await input.controller.querySelectorAllByNodeId({
          nodeId: rootId,
          selector: candidate,
        });
        if (matches.length === 1 && matches[0] === entry.nodeId) {
          css = candidate;
          break;
        }
      }
    }
    enriched.push(css === undefined ? ref : { ...ref, locator: { css, unique: true } });
  }
  const nodes = filterNodes(input.snapshot.nodes);
  let nodeCount = 0;
  const count = (items: readonly BrowserAxNode[]): void => {
    for (const node of items) {
      nodeCount += 1;
      count(node.children ?? []);
    }
  };
  count(nodes);
  const coverageWarnings: string[] = [...(input.snapshot.coverageWarnings ?? [])];
  if (scopedEntries.some((entry) => entry.tag === "canvas")) {
    coverageWarnings.push("canvas_requires_visual_observation");
  }
  if (scopedEntries.some((entry) => entry.tag === "iframe")) {
    coverageWarnings.push("iframe_coverage_is_best_effort_oopif_may_be_missing");
  }
  if (truncated) coverageWarnings.push("dom_context_scan_truncated");
  if (input.snapshot.truncated) coverageWarnings.push("accessibility_snapshot_truncated");
  return {
    ...input.snapshot,
    nodes,
    refs: enriched,
    nodeCount,
    snapshotId: randomUUID(),
    browserInstance: input.browserInstance,
    pageId: input.pageId,
    documentId,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    coverageWarnings,
  };
}
