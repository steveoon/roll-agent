import { randomUUID } from "node:crypto";
import type {
  BrowserDomActionHint,
  BrowserDomActionKind,
  NativeCdpController,
  NativeCdpDomNode,
} from "@roll-agent/browser";

type RawDomActionCandidate = {
  readonly marker: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly hasClassHint: boolean;
  readonly hasCursorPointer: boolean;
  readonly hasOnClick: boolean;
  readonly hasTabIndex: boolean;
  readonly isEditable: boolean;
};

type DomActionCandidateController = Pick<
  NativeCdpController,
  "describeNode" | "evaluateJson" | "getDocument" | "querySelectorAllByNodeId"
>;

const DOM_ACTION_MARKER_ATTR_PREFIX = "data-roll-browser-action-";
const MAX_DOM_ACTION_CANDIDATES = 120;

function createDomActionMarkerAttribute(): string {
  return `${DOM_ACTION_MARKER_ATTR_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

function normalizeCandidateLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return MAX_DOM_ACTION_CANDIDATES;
  }
  return Math.max(0, Math.min(Math.trunc(value), MAX_DOM_ACTION_CANDIDATES));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRootNodeId(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value["root"])) {
    return undefined;
  }

  const nodeId = value["root"]["nodeId"];
  return typeof nodeId === "number" && Number.isInteger(nodeId) ? nodeId : undefined;
}

function readMarker(
  markerAttribute: string,
  attributes: readonly string[] | undefined,
): string | undefined {
  if (attributes === undefined) {
    return undefined;
  }

  for (let index = 0; index < attributes.length - 1; index += 2) {
    if (attributes[index] === markerAttribute) {
      return attributes[index + 1];
    }
  }
  return undefined;
}

function toRawDomActionCandidate(value: unknown): RawDomActionCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const marker = value["marker"];
  const name = value["name"];
  if (typeof marker !== "string" || typeof name !== "string" || name.trim().length === 0) {
    return undefined;
  }

  return {
    marker,
    name: name.trim(),
    disabled: value["disabled"] === true,
    hasClassHint: value["hasClassHint"] === true,
    hasCursorPointer: value["hasCursorPointer"] === true,
    hasOnClick: value["hasOnClick"] === true,
    hasTabIndex: value["hasTabIndex"] === true,
    isEditable: value["isEditable"] === true,
  };
}

function toRawDomActionCandidates(value: unknown): readonly RawDomActionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const candidate = toRawDomActionCandidate(item);
    return candidate === undefined ? [] : [candidate];
  });
}

function createDomActionKind(candidate: RawDomActionCandidate): BrowserDomActionKind {
  if (candidate.isEditable) {
    return "editable";
  }
  if (candidate.hasCursorPointer || candidate.hasOnClick || candidate.hasClassHint) {
    return "clickable";
  }
  return "focusable";
}

function createDomActionHints(candidate: RawDomActionCandidate): readonly string[] {
  const hints: string[] = [];
  if (candidate.hasCursorPointer) {
    hints.push("cursor:pointer");
  }
  if (candidate.hasOnClick) {
    hints.push("onclick");
  }
  if (candidate.hasTabIndex) {
    hints.push("tabindex");
  }
  if (candidate.isEditable) {
    hints.push("contenteditable");
  }
  if (candidate.hasClassHint) {
    hints.push("class:action");
  }
  return hints;
}

function createBackendNodeIdByMarker(
  markerAttribute: string,
  nodes: readonly NativeCdpDomNode[],
): ReadonlyMap<string, number> {
  const backendNodeIdByMarker = new Map<string, number>();
  for (const node of nodes) {
    const marker = readMarker(markerAttribute, node.attributes);
    if (marker !== undefined && node.backendNodeId !== undefined) {
      backendNodeIdByMarker.set(marker, node.backendNodeId);
    }
  }
  return backendNodeIdByMarker;
}

function buildDomActionCandidateExpression(markerAttribute: string, maxCandidates: number): string {
  return `(() => {
    const markerAttribute = ${JSON.stringify(markerAttribute)};
    const maxCandidates = ${JSON.stringify(maxCandidates)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const classTextOf = (element) => String(element.getAttribute("class") ?? "");
    const directTextOf = (element) => normalize(Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" "));
    const domActionNameOf = (element) => {
      const direct = directTextOf(element);
      if (direct) return direct;
      return element.childElementCount === 0 ? normalize(element.textContent) : "";
    };
    const isVisible = (element) => {
      if (element.closest("[hidden], [aria-hidden=\\"true\\"]")) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isDisabled = (element) =>
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.getAttribute("disabled") !== null;
    const isNativeSemantic = (element) => {
      const tag = element.tagName.toLowerCase();
      return (
        (tag === "a" && element.hasAttribute("href")) ||
        tag === "button" ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        tag === "option" ||
        tag === "summary" ||
        element.hasAttribute("role")
      );
    };
    const hasNearbyClassHint = (element) => {
      const pattern = /btn|button|click|tab|tabs|filter|menu|nav|option|select|switch|toggle/i;
      let current = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        if (pattern.test(classTextOf(current))) return true;
        current = current.parentElement;
      }
      return false;
    };
    const isCandidate = (element) => {
      if (!isVisible(element) || isNativeSemantic(element)) return false;
      const tag = element.tagName.toLowerCase();
      if (!["span", "div", "li", "label", "em", "i", "b", "strong"].includes(tag)) return false;
      const name = domActionNameOf(element);
      if (name.length === 0 || name.length > 100) return false;
      const style = window.getComputedStyle(element);
      const hasCursorPointer = style.cursor === "pointer";
      const hasOnClick = element.hasAttribute("onclick") || element.onclick !== null;
      const hasTabIndex = element.getAttribute("tabindex") !== null && element.getAttribute("tabindex") !== "-1";
      const contentEditable = element.getAttribute("contenteditable");
      const isEditable = contentEditable === "" || contentEditable === "true";
      const hasClassHint = hasNearbyClassHint(element);

      if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable && !hasClassHint) {
        return false;
      }

      if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable && !hasClassHint) {
        const parent = element.parentElement;
        if (parent && window.getComputedStyle(parent).cursor === "pointer") return false;
      }
      return true;
    };
    const output = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!isCandidate(element)) continue;
      const marker = String(output.length);
      const style = window.getComputedStyle(element);
      const contentEditable = element.getAttribute("contenteditable");
      element.setAttribute(markerAttribute, marker);
      output.push({
        marker,
        name: domActionNameOf(element),
        disabled: isDisabled(element),
        hasClassHint: hasNearbyClassHint(element),
        hasCursorPointer: style.cursor === "pointer",
        hasOnClick: element.hasAttribute("onclick") || element.onclick !== null,
        hasTabIndex: element.getAttribute("tabindex") !== null && element.getAttribute("tabindex") !== "-1",
        isEditable: contentEditable === "" || contentEditable === "true"
      });
      if (output.length >= maxCandidates) break;
    }
    return output;
  })()`;
}

function buildCleanupExpression(markerAttribute: string): string {
  return `(() => {
    const markerAttribute = ${JSON.stringify(markerAttribute)};
    const elements = document.querySelectorAll("[" + markerAttribute + "]");
    for (const element of elements) {
      element.removeAttribute(markerAttribute);
    }
    return elements.length;
  })()`;
}

async function resolveCandidateBackendNodeIds(
  controller: DomActionCandidateController,
  markerAttribute: string,
): Promise<ReadonlyMap<string, number>> {
  const document = await controller.getDocument({ depth: 0 });
  const rootNodeId = readRootNodeId(document);
  if (rootNodeId === undefined) {
    return new Map();
  }

  const nodeIds = await controller.querySelectorAllByNodeId({
    nodeId: rootNodeId,
    selector: `[${markerAttribute}]`,
  });
  const nodes = await Promise.all(
    nodeIds.map(async (nodeId) => await controller.describeNode({ nodeId })),
  );
  return createBackendNodeIdByMarker(markerAttribute, nodes);
}

export async function collectDomActionHints(
  controller: DomActionCandidateController,
  maxCandidates = MAX_DOM_ACTION_CANDIDATES,
): Promise<readonly BrowserDomActionHint[]> {
  const candidateLimit = normalizeCandidateLimit(maxCandidates);
  if (candidateLimit === 0) {
    return [];
  }

  const markerAttribute = createDomActionMarkerAttribute();
  const candidates = toRawDomActionCandidates(
    await controller
      .evaluateJson(buildDomActionCandidateExpression(markerAttribute, candidateLimit))
      .catch(() => []),
  );

  try {
    if (candidates.length === 0) {
      return [];
    }

    const backendNodeIdByMarker = await resolveCandidateBackendNodeIds(controller, markerAttribute);
    return candidates.flatMap((candidate) => {
      const backendNodeId = backendNodeIdByMarker.get(candidate.marker);
      if (backendNodeId === undefined) {
        return [];
      }

      return [
        {
          backendNodeId,
          kind: createDomActionKind(candidate),
          name: candidate.name,
          hints: createDomActionHints(candidate),
          disabled: candidate.disabled,
        },
      ];
    });
  } finally {
    await controller.evaluateJson(buildCleanupExpression(markerAttribute)).catch(() => undefined);
  }
}
