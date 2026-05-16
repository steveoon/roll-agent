import type {
  BrowserAxNode,
  BrowserAxPropertyValue,
  BrowserAxSnapshot,
  BrowserElementRef,
  BrowserElementRefHandle,
} from "../types/index.ts";
import type { NativeCdpController } from "./native-cdp-controller.ts";

const DEFAULT_BROWSER_AX_SNAPSHOT_MAX_NODES = 500;
const BROWSER_ELEMENT_REF_PATTERN = /^@e[1-9]\d*$/;

const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "iframe",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export const BROWSER_DOM_ACTION_KINDS = ["clickable", "focusable", "editable"] as const;
export type BrowserDomActionKind = (typeof BROWSER_DOM_ACTION_KINDS)[number];

export type BrowserDomActionHint = {
  readonly backendNodeId: number;
  readonly kind: BrowserDomActionKind;
  readonly name: string;
  readonly hints: readonly string[];
  readonly disabled: boolean;
};

export type BrowserAxSnapshotOptions = {
  readonly domActionHints?: readonly BrowserDomActionHint[];
  readonly depthOffset?: number;
  readonly frameId?: string;
  readonly initialRefCount?: number;
  readonly interactiveOnly?: boolean;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly timeoutMs?: number;
};

type RawAxNode = {
  readonly nodeId: string;
  readonly childIds: readonly string[];
  readonly ignored: boolean;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly description?: string;
  readonly backendNodeId?: number;
  readonly properties: Readonly<Record<string, BrowserAxPropertyValue>>;
};

type SnapshotBuildState = {
  nodeCount: number;
  refCount: number;
  truncated: boolean;
  readonly depthOffset: number;
  readonly frameId?: string;
  readonly maxNodes: number;
  readonly refs: BrowserElementRef[];
  readonly nthByRoleName: Map<string, number>;
};

function createDomActionHintMap(
  hints: readonly BrowserDomActionHint[] | undefined,
): ReadonlyMap<number, BrowserDomActionHint> {
  const map = new Map<number, BrowserDomActionHint>();
  for (const hint of hints ?? []) {
    if (Number.isInteger(hint.backendNodeId) && hint.backendNodeId > 0) {
      map.set(hint.backendNodeId, hint);
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPropertyValue(value: unknown): BrowserAxPropertyValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readAxValue(value: unknown): BrowserAxPropertyValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return toPropertyValue(value["value"]);
}

function readAxText(value: unknown): string | undefined {
  const axValue = readAxValue(value);
  if (axValue === undefined) {
    return undefined;
  }
  return String(axValue);
}

function normalizeAxText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isBrowserDomActionKind(value: string): value is BrowserDomActionKind {
  return BROWSER_DOM_ACTION_KINDS.some((kind) => kind === value);
}

function readChildIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((childId): childId is string => typeof childId === "string");
}

function readProperties(value: unknown): Readonly<Record<string, BrowserAxPropertyValue>> {
  if (!Array.isArray(value)) {
    return {};
  }

  const properties: Record<string, BrowserAxPropertyValue> = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item["name"] !== "string") {
      continue;
    }

    const propertyValue = readAxValue(item["value"]);
    if (propertyValue !== undefined) {
      properties[item["name"]] = propertyValue;
    }
  }
  return properties;
}

function toRawAxNode(value: unknown): RawAxNode | undefined {
  if (!isRecord(value) || typeof value["nodeId"] !== "string") {
    return undefined;
  }

  const valueText = readAxText(value["value"]);
  const descriptionText = readAxText(value["description"]);
  const backendNodeId = value["backendDOMNodeId"];
  const parsedBackendNodeId =
    typeof backendNodeId === "number" && Number.isInteger(backendNodeId) && backendNodeId > 0
      ? backendNodeId
      : undefined;

  return {
    nodeId: value["nodeId"],
    childIds: readChildIds(value["childIds"]),
    ignored: typeof value["ignored"] === "boolean" ? value["ignored"] : false,
    role: normalizeAxText(readAxText(value["role"]) ?? "unknown").toLowerCase(),
    name: normalizeAxText(readAxText(value["name"]) ?? ""),
    ...(valueText !== undefined ? { value: valueText } : {}),
    ...(descriptionText !== undefined ? { description: descriptionText } : {}),
    ...(parsedBackendNodeId !== undefined ? { backendNodeId: parsedBackendNodeId } : {}),
    properties: readProperties(value["properties"]),
  };
}

function toDomActionProperties(
  node: RawAxNode | undefined,
  hint: BrowserDomActionHint,
): Readonly<Record<string, BrowserAxPropertyValue>> {
  return {
    ...(node?.properties ?? {}),
    domActionable: true,
    domActionKind: hint.kind,
    domActionHints: hint.hints.join(", "),
    ...(node !== undefined ? { originalRole: node.role } : {}),
    ...(hint.disabled ? { disabled: true } : {}),
  };
}

function applyDomActionHints(
  nodes: readonly RawAxNode[],
  hints: ReadonlyMap<number, BrowserDomActionHint>,
): readonly RawAxNode[] {
  if (hints.size === 0) {
    return nodes;
  }

  const matchedBackendNodeIds = new Set<number>();
  const enrichedNodes = nodes.map((node) => {
    const hint = node.backendNodeId !== undefined ? hints.get(node.backendNodeId) : undefined;
    if (hint === undefined || node.ignored) {
      return node;
    }

    matchedBackendNodeIds.add(hint.backendNodeId);
    return {
      ...node,
      role: hint.kind,
      name: node.name.length > 0 ? node.name : hint.name,
      properties: toDomActionProperties(node, hint),
    };
  });

  const syntheticNodes = [...hints.values()].flatMap((hint) => {
    if (matchedBackendNodeIds.has(hint.backendNodeId)) {
      return [];
    }

    return [
      {
        nodeId: `dom-action:${String(hint.backendNodeId)}`,
        childIds: [],
        ignored: false,
        role: hint.kind,
        name: hint.name,
        backendNodeId: hint.backendNodeId,
        properties: toDomActionProperties(undefined, hint),
      },
    ];
  });

  return [...enrichedNodes, ...syntheticNodes];
}

function calculateDepths(nodes: readonly RawAxNode[]): ReadonlyMap<string, number> {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childIdSet = new Set(nodes.flatMap((node) => node.childIds));
  const roots = nodes.filter((node) => !childIdSet.has(node.nodeId));
  const depths = new Map<string, number>();

  const visit = (node: RawAxNode, depth: number, seen: ReadonlySet<string>): void => {
    const existingDepth = depths.get(node.nodeId);
    if (existingDepth !== undefined && existingDepth <= depth) {
      return;
    }
    depths.set(node.nodeId, depth);

    if (seen.has(node.nodeId)) {
      return;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node.nodeId);
    for (const childId of node.childIds) {
      const child = nodeById.get(childId);
      if (child !== undefined) {
        visit(child, depth + 1, nextSeen);
      }
    }
  };

  const rootNodes = roots.length > 0 ? roots : nodes.slice(0, 1);
  for (const root of rootNodes) {
    visit(root, 0, new Set());
  }

  for (const node of nodes) {
    if (!depths.has(node.nodeId)) {
      depths.set(node.nodeId, 0);
    }
  }

  return depths;
}

function isInteractiveAxNode(node: RawAxNode): boolean {
  if (node.backendNodeId === undefined || node.ignored) {
    return false;
  }

  const role = node.role.toLowerCase();
  return (
    INTERACTIVE_AX_ROLES.has(role) ||
    (node.properties["domActionable"] === true && isBrowserDomActionKind(role)) ||
    node.properties["focusable"] === true ||
    node.properties["editable"] === "richtext" ||
    node.properties["editable"] === "plaintext"
  );
}

function createBuildState(input: {
  readonly depthOffset: number;
  readonly frameId?: string;
  readonly initialRefCount: number;
  readonly maxNodes: number;
}): SnapshotBuildState {
  return {
    nodeCount: 0,
    refCount: input.initialRefCount,
    truncated: false,
    depthOffset: input.depthOffset,
    ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
    maxNodes: input.maxNodes,
    refs: [],
    nthByRoleName: new Map(),
  };
}

function reserveNode(state: SnapshotBuildState): boolean {
  if (state.nodeCount >= state.maxNodes) {
    state.truncated = true;
    return false;
  }

  state.nodeCount += 1;
  return true;
}

function createElementRef(
  state: SnapshotBuildState,
  node: RawAxNode,
): BrowserElementRef | undefined {
  if (!isInteractiveAxNode(node) || node.backendNodeId === undefined) {
    return undefined;
  }

  const roleNameKey = `${node.role}\u0000${node.name}`;
  const nth = state.nthByRoleName.get(roleNameKey) ?? 0;
  state.nthByRoleName.set(roleNameKey, nth + 1);

  state.refCount += 1;
  const ref = `@e${state.refCount}` as BrowserElementRefHandle;
  const elementRef: BrowserElementRef = {
    ref,
    backendNodeId: node.backendNodeId,
    ...(state.frameId !== undefined ? { frameId: state.frameId } : {}),
    role: node.role,
    name: node.name,
    nth,
    disabled: node.properties["disabled"] === true,
  };
  state.refs.push(elementRef);
  return elementRef;
}

function createBrowserAxNode(
  node: RawAxNode,
  depth: number,
  frameId: string | undefined,
  ref: BrowserElementRef | undefined,
  children: readonly BrowserAxNode[] = [],
): BrowserAxNode {
  const hasProperties = Object.keys(node.properties).length > 0;
  return {
    ...(ref !== undefined ? { ref: ref.ref } : {}),
    role: node.role,
    ...(node.name.length > 0 ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    ignored: node.ignored,
    depth,
    ...(node.backendNodeId !== undefined ? { backendNodeId: node.backendNodeId } : {}),
    ...(frameId !== undefined ? { frameId } : {}),
    ...(hasProperties ? { properties: node.properties } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function isWithinMaxDepth(
  node: RawAxNode,
  depths: ReadonlyMap<string, number>,
  maxDepth: number | undefined,
): boolean {
  if (maxDepth === undefined) {
    return true;
  }
  return (depths.get(node.nodeId) ?? 0) <= maxDepth;
}

function buildInteractiveNodeList(input: {
  readonly nodes: readonly RawAxNode[];
  readonly depths: ReadonlyMap<string, number>;
  readonly maxDepth?: number;
  readonly state: SnapshotBuildState;
}): BrowserAxNode[] {
  const output: BrowserAxNode[] = [];

  for (const node of input.nodes) {
    if (!isWithinMaxDepth(node, input.depths, input.maxDepth) || !isInteractiveAxNode(node)) {
      continue;
    }
    if (!reserveNode(input.state)) {
      break;
    }

    const ref = createElementRef(input.state, node);
    output.push(
      createBrowserAxNode(
        node,
        (input.depths.get(node.nodeId) ?? 0) + input.state.depthOffset,
        input.state.frameId,
        ref,
      ),
    );
  }

  return output;
}

function buildAxTree(input: {
  readonly nodes: readonly RawAxNode[];
  readonly depths: ReadonlyMap<string, number>;
  readonly maxDepth?: number;
  readonly state: SnapshotBuildState;
}): BrowserAxNode[] {
  const nodeById = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const childIdSet = new Set(input.nodes.flatMap((node) => node.childIds));
  const roots = input.nodes.filter((node) => !childIdSet.has(node.nodeId));
  const rootNodes = roots.length > 0 ? roots : input.nodes.slice(0, 1);

  const visit = (node: RawAxNode, seen: ReadonlySet<string>): BrowserAxNode | undefined => {
    if (!isWithinMaxDepth(node, input.depths, input.maxDepth) || !reserveNode(input.state)) {
      return undefined;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node.nodeId);
    const ref = createElementRef(input.state, node);
    const children: BrowserAxNode[] = [];
    for (const childId of node.childIds) {
      if (nextSeen.has(childId)) {
        continue;
      }

      const child = nodeById.get(childId);
      if (child === undefined) {
        continue;
      }

      const childNode = visit(child, nextSeen);
      if (childNode !== undefined) {
        children.push(childNode);
      }
    }

    return createBrowserAxNode(
      node,
      (input.depths.get(node.nodeId) ?? 0) + input.state.depthOffset,
      input.state.frameId,
      ref,
      children,
    );
  };

  return rootNodes.flatMap((node) => {
    const output = visit(node, new Set());
    return output === undefined ? [] : [output];
  });
}

export function isBrowserElementRefHandle(value: string): value is BrowserElementRefHandle {
  return BROWSER_ELEMENT_REF_PATTERN.test(value);
}

export async function createBrowserAxSnapshot(
  controller: Pick<NativeCdpController, "getFullAccessibilityTree">,
  options: BrowserAxSnapshotOptions = {},
): Promise<BrowserAxSnapshot> {
  const maxNodes = options.maxNodes ?? DEFAULT_BROWSER_AX_SNAPSHOT_MAX_NODES;
  const interactiveOnly = options.interactiveOnly ?? true;
  const frameId = options.frameId;
  const rawNodes = applyDomActionHints(
    (
      await controller.getFullAccessibilityTree({
        ...(options.maxDepth !== undefined ? { depth: options.maxDepth } : {}),
        ...(frameId !== undefined ? { frameId } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
    ).flatMap((node) => {
      const parsed = toRawAxNode(node);
      return parsed === undefined ? [] : [parsed];
    }),
    createDomActionHintMap(options.domActionHints),
  );
  const depths = calculateDepths(rawNodes);
  const state = createBuildState({
    depthOffset: options.depthOffset ?? 0,
    ...(frameId !== undefined ? { frameId } : {}),
    initialRefCount: options.initialRefCount ?? 0,
    maxNodes,
  });
  const nodes = interactiveOnly
    ? buildInteractiveNodeList({
        nodes: rawNodes,
        depths,
        state,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      })
    : buildAxTree({
        nodes: rawNodes,
        depths,
        state,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      });

  return {
    nodes,
    refs: state.refs,
    nodeCount: state.nodeCount,
    truncated: state.truncated,
    maxNodes,
    interactiveOnly,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };
}
