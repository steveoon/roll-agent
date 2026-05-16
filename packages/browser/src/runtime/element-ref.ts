import type {
  BrowserElementRef,
  BrowserElementRefHandle,
  BrowserAxSnapshot,
  BrowserAxPropertyValue,
} from "../types/index.ts";
import type {
  NativeCdpBoxModel,
  NativeCdpController,
  NativeCdpKeyEventInput,
} from "./native-cdp-controller.ts";

const MAC_META_MODIFIER = 4;
const CONTROL_MODIFIER = 2;
const DOM_ACTION_REF_ROLES = new Set(["clickable", "focusable", "editable"]);

export type BrowserElementRefResolveStrategy = "backend_node_id" | "role_name_nth";

export type BrowserElementRefTarget = {
  readonly ref: BrowserElementRefHandle;
  readonly role: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly resolvedBy: BrowserElementRefResolveStrategy;
  readonly backendNodeId?: number;
  readonly frameId?: string;
  readonly disabled: boolean;
};

export type BrowserElementRefActionResult = {
  readonly success: true;
  readonly ref: BrowserElementRefHandle;
  readonly resolvedBy: BrowserElementRefResolveStrategy;
  readonly target: BrowserElementRefTarget;
};

export type BrowserElementRefClickDispatcher = (target: BrowserElementRefTarget) => Promise<void>;

export type BrowserElementRefClickOptions = {
  readonly clickTarget?: BrowserElementRefClickDispatcher;
  readonly timeoutMs?: number;
};

export type BrowserElementRefTypeOptions = {
  readonly clickTarget?: BrowserElementRefClickDispatcher;
  readonly clear?: boolean;
  readonly timeoutMs?: number;
};

type ElementRefController = Pick<
  NativeCdpController,
  | "dispatchKeyEvent"
  | "dispatchMouseEvent"
  | "evaluateJson"
  | "getBoxModelByBackendNodeId"
  | "getFullAccessibilityTree"
  | "insertText"
  | "preflightAction"
  | "scrollIntoViewByBackendNodeId"
>;

type BrowserElementRefFallbackTarget = {
  readonly found: boolean;
  readonly x: number;
  readonly y: number;
  readonly role: string;
  readonly name: string;
  readonly disabled: boolean;
};

type Point = {
  readonly x: number;
  readonly y: number;
};

type AxFallbackMatch = {
  readonly backendNodeId: number;
  readonly disabled: boolean;
};

type Quad = readonly [number, number, number, number, number, number, number, number];

export class BrowserElementRefStore {
  private readonly refsByPage = new Map<
    string,
    ReadonlyMap<BrowserElementRefHandle, BrowserElementRef>
  >();

  saveSnapshot(pageKey: string, snapshot: BrowserAxSnapshot): void {
    this.refsByPage.set(
      pageKey,
      new Map(snapshot.refs.map((elementRef) => [elementRef.ref, elementRef])),
    );
  }

  getRef(pageKey: string, ref: BrowserElementRefHandle): BrowserElementRef | undefined {
    return this.refsByPage.get(pageKey)?.get(ref);
  }

  clear(pageKey?: string): void {
    if (pageKey === undefined) {
      this.refsByPage.clear();
      return;
    }
    this.refsByPage.delete(pageKey);
  }
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
  return axValue === undefined ? undefined : String(axValue);
}

function normalizeAxText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readAxProperty(value: unknown, propertyName: string): BrowserAxPropertyValue | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    if (!isRecord(item) || item["name"] !== propertyName) {
      continue;
    }

    const propertyValue = readAxValue(item["value"]);
    if (propertyValue !== undefined) {
      return propertyValue;
    }
  }
  return undefined;
}

function toFallbackTarget(value: unknown): BrowserElementRefFallbackTarget {
  if (!isRecord(value)) {
    return {
      found: false,
      x: 0,
      y: 0,
      role: "",
      name: "",
      disabled: false,
    };
  }

  return {
    found: value["found"] === true,
    x: typeof value["x"] === "number" ? value["x"] : 0,
    y: typeof value["y"] === "number" ? value["y"] : 0,
    role: typeof value["role"] === "string" ? value["role"] : "",
    name: typeof value["name"] === "string" ? value["name"] : "",
    disabled: value["disabled"] === true,
  };
}

function toQuad(value: readonly number[] | undefined): Quad | undefined {
  if (value === undefined || value.length < 8) {
    return undefined;
  }

  const x1 = value[0];
  const y1 = value[1];
  const x2 = value[2];
  const y2 = value[3];
  const x3 = value[4];
  const y3 = value[5];
  const x4 = value[6];
  const y4 = value[7];
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    x3 === undefined ||
    y3 === undefined ||
    x4 === undefined ||
    y4 === undefined
  ) {
    return undefined;
  }

  return [x1, y1, x2, y2, x3, y3, x4, y4];
}

function pointFromQuad(quad: Quad): Point {
  return {
    x: Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4),
    y: Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4),
  };
}

function pointFromBoxModel(model: NativeCdpBoxModel | undefined): Point | undefined {
  const quad =
    toQuad(model?.border) ??
    toQuad(model?.content) ??
    toQuad(model?.padding) ??
    toQuad(model?.margin);
  return quad === undefined ? undefined : pointFromQuad(quad);
}

async function resolveByBackendNodeId(
  controller: ElementRefController,
  elementRef: BrowserElementRef,
  timeoutMs: number | undefined,
): Promise<Point | undefined> {
  if (elementRef.backendNodeId === undefined) {
    return undefined;
  }

  await controller
    .scrollIntoViewByBackendNodeId({
      backendNodeId: elementRef.backendNodeId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    .catch(() => {});

  const model = await controller
    .getBoxModelByBackendNodeId({
      backendNodeId: elementRef.backendNodeId,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    .catch(() => undefined);
  return pointFromBoxModel(model);
}

async function resolveByRoleNameNth(
  controller: ElementRefController,
  elementRef: BrowserElementRef,
  timeoutMs: number | undefined,
): Promise<BrowserElementRefFallbackTarget | undefined> {
  const axFallback = await resolveFrameRefByAxTree(controller, elementRef, timeoutMs);
  if (axFallback !== undefined) {
    return axFallback;
  }
  if (elementRef.frameId !== undefined) {
    return undefined;
  }

  const fallback = toFallbackTarget(
    await controller.evaluateJson(buildRoleNameNthFallbackExpression(elementRef), {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  );

  return fallback.found ? fallback : undefined;
}

async function resolveFrameRefByAxTree(
  controller: ElementRefController,
  elementRef: BrowserElementRef,
  timeoutMs: number | undefined,
): Promise<BrowserElementRefFallbackTarget | undefined> {
  if (elementRef.frameId === undefined || DOM_ACTION_REF_ROLES.has(elementRef.role)) {
    return undefined;
  }

  const match = await findAxFallbackMatch(controller, elementRef, timeoutMs).catch(() => undefined);
  if (match === undefined) {
    return undefined;
  }

  const point = await resolveByBackendNodeId(
    controller,
    {
      ...elementRef,
      backendNodeId: match.backendNodeId,
    },
    timeoutMs,
  );
  if (point === undefined) {
    return undefined;
  }

  return {
    found: true,
    x: point.x,
    y: point.y,
    role: elementRef.role,
    name: elementRef.name,
    disabled: match.disabled,
  };
}

async function findAxFallbackMatch(
  controller: ElementRefController,
  elementRef: BrowserElementRef,
  timeoutMs: number | undefined,
): Promise<AxFallbackMatch | undefined> {
  if (elementRef.frameId === undefined) {
    return undefined;
  }

  const nodes = await controller.getFullAccessibilityTree({
    frameId: elementRef.frameId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  let matchCount = 0;
  for (const node of nodes) {
    if (!isRecord(node) || node["ignored"] === true) {
      continue;
    }

    const role = normalizeAxText(readAxText(node["role"]) ?? "").toLowerCase();
    const name = normalizeAxText(readAxText(node["name"]) ?? "");
    if (role !== elementRef.role || name !== elementRef.name) {
      continue;
    }

    if (matchCount !== elementRef.nth) {
      matchCount += 1;
      continue;
    }

    const backendNodeId = node["backendDOMNodeId"];
    if (
      typeof backendNodeId !== "number" ||
      !Number.isInteger(backendNodeId) ||
      backendNodeId <= 0
    ) {
      return undefined;
    }

    return {
      backendNodeId,
      disabled: readAxProperty(node["properties"], "disabled") === true,
    };
  }

  return undefined;
}

async function resolveElementRef(input: {
  readonly controller: ElementRefController;
  readonly elementRef: BrowserElementRef;
  readonly action: "click" | "type";
  readonly timeoutMs?: number;
}): Promise<BrowserElementRefTarget> {
  input.controller.preflightAction({
    action: input.action,
    target: input.elementRef.ref,
  });

  const backendPoint = await resolveByBackendNodeId(
    input.controller,
    input.elementRef,
    input.timeoutMs,
  );
  if (backendPoint !== undefined) {
    return {
      ref: input.elementRef.ref,
      role: input.elementRef.role,
      name: input.elementRef.name,
      x: backendPoint.x,
      y: backendPoint.y,
      resolvedBy: "backend_node_id",
      ...(input.elementRef.backendNodeId !== undefined
        ? { backendNodeId: input.elementRef.backendNodeId }
        : {}),
      ...(input.elementRef.frameId !== undefined ? { frameId: input.elementRef.frameId } : {}),
      disabled: input.elementRef.disabled,
    };
  }

  const fallbackTarget = await resolveByRoleNameNth(
    input.controller,
    input.elementRef,
    input.timeoutMs,
  );
  if (fallbackTarget === undefined) {
    throw new Error(
      `Element ref ${input.elementRef.ref} is stale and role/name/nth fallback did not match.`,
    );
  }

  return {
    ref: input.elementRef.ref,
    role: fallbackTarget.role,
    name: fallbackTarget.name,
    x: fallbackTarget.x,
    y: fallbackTarget.y,
    resolvedBy: "role_name_nth",
    ...(input.elementRef.backendNodeId !== undefined
      ? { backendNodeId: input.elementRef.backendNodeId }
      : {}),
    ...(input.elementRef.frameId !== undefined ? { frameId: input.elementRef.frameId } : {}),
    disabled: fallbackTarget.disabled,
  };
}

async function dispatchClickAt(
  controller: ElementRefController,
  point: Point,
  clickCount = 1,
): Promise<void> {
  await controller.dispatchMouseEvent({
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    buttons: 0,
  });
  await controller.dispatchMouseEvent({
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount,
  });
  await controller.dispatchMouseEvent({
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount,
  });
}

async function dispatchKeyPress(
  controller: ElementRefController,
  input: Omit<NativeCdpKeyEventInput, "type">,
): Promise<void> {
  await controller.dispatchKeyEvent({
    ...input,
    type: "rawKeyDown",
  });
  await controller.dispatchKeyEvent({
    ...input,
    type: "keyUp",
  });
}

async function clearFocusedText(controller: ElementRefController): Promise<void> {
  const modifiers = process.platform === "darwin" ? MAC_META_MODIFIER : CONTROL_MODIFIER;
  await dispatchKeyPress(controller, {
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers,
  });
  await dispatchKeyPress(controller, {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
}

function createActionResult(target: BrowserElementRefTarget): BrowserElementRefActionResult {
  return {
    success: true,
    ref: target.ref,
    resolvedBy: target.resolvedBy,
    target,
  };
}

export async function clickElementRef(input: {
  readonly controller: ElementRefController;
  readonly elementRef: BrowserElementRef;
  readonly options?: BrowserElementRefClickOptions;
  readonly timeoutMs?: number;
}): Promise<BrowserElementRefActionResult> {
  const target = await resolveElementRef({
    controller: input.controller,
    elementRef: input.elementRef,
    action: "click",
    ...(input.options?.timeoutMs !== undefined || input.timeoutMs !== undefined
      ? { timeoutMs: input.options?.timeoutMs ?? input.timeoutMs }
      : {}),
  });
  if (target.disabled) {
    throw new Error(`Element ref ${input.elementRef.ref} resolved to a disabled element.`);
  }

  if (input.options?.clickTarget !== undefined) {
    await input.options.clickTarget(target);
  } else {
    await dispatchClickAt(input.controller, target);
  }
  return createActionResult(target);
}

export async function typeElementRef(input: {
  readonly controller: ElementRefController;
  readonly elementRef: BrowserElementRef;
  readonly text: string;
  readonly options?: BrowserElementRefTypeOptions;
}): Promise<BrowserElementRefActionResult> {
  const target = await resolveElementRef({
    controller: input.controller,
    elementRef: input.elementRef,
    action: "type",
    ...(input.options?.timeoutMs !== undefined ? { timeoutMs: input.options.timeoutMs } : {}),
  });
  if (target.disabled) {
    throw new Error(`Element ref ${input.elementRef.ref} resolved to a disabled element.`);
  }

  if (input.options?.clickTarget !== undefined) {
    await input.options.clickTarget(target);
  } else {
    await dispatchClickAt(input.controller, target);
  }
  if (input.options?.clear === true) {
    await clearFocusedText(input.controller);
  }
  await input.controller.insertText(input.text);
  return createActionResult(target);
}

function buildRoleNameNthFallbackExpression(elementRef: BrowserElementRef): string {
  return `(() => {
    const targetRole = ${JSON.stringify(elementRef.role.toLowerCase())};
    const targetName = ${JSON.stringify(elementRef.name)};
    const targetNth = ${JSON.stringify(elementRef.nth)};

    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textByIds = (ids) => ids
      .split(/\\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const roleOf = (element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "option") return "option";
      if (element.getAttribute("contenteditable") === "true") return "textbox";
      if (tag !== "input") return "";
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    };
    const classTextOf = (element) => String(element.getAttribute("class") ?? "");
    const hasNearbyClickHint = (element) => {
      const pattern = /btn|button|click|tab|tabs|filter|menu|nav|option|select|switch|toggle/i;
      let current = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        if (pattern.test(classTextOf(current))) return true;
        current = current.parentElement;
      }
      return false;
    };
    const directTextOf = (element) => normalize(Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" "));
    const domActionNameOf = (element) => {
      const direct = directTextOf(element);
      if (direct) return direct;
      return element.childElementCount === 0 ? normalize(element.textContent) : "";
    };
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
    const isDomActionCandidate = (element) => {
      if (isNativeSemantic(element)) return false;
      const tag = element.tagName.toLowerCase();
      if (!["span", "div", "li", "label", "em", "i", "b", "strong"].includes(tag)) return false;
      const name = domActionNameOf(element);
      if (name.length === 0 || name.length > 100) return false;
      const style = window.getComputedStyle(element);
      const contentEditable = element.getAttribute("contenteditable");
      return (
        style.cursor === "pointer" ||
        element.hasAttribute("onclick") ||
        (element.getAttribute("tabindex") !== null && element.getAttribute("tabindex") !== "-1") ||
        contentEditable === "" ||
        contentEditable === "true" ||
        hasNearbyClickHint(element)
      );
    };
    const domActionKindOf = (element) => {
      if (!isDomActionCandidate(element)) return "";
      const style = window.getComputedStyle(element);
      const contentEditable = element.getAttribute("contenteditable");
      if (contentEditable === "" || contentEditable === "true") return "editable";
      if (
        style.cursor === "pointer" ||
        element.hasAttribute("onclick") ||
        hasNearbyClickHint(element)
      ) {
        return "clickable";
      }
      return "focusable";
    };
    const semanticRoleOf = (element) => {
      const role = roleOf(element);
      if (role) return role;
      return domActionKindOf(element);
    };
    const nameOf = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const ariaLabel = element.getAttribute("aria-label");
      const alt = element.getAttribute("alt");
      const title = element.getAttribute("title");
      const placeholder = element.getAttribute("placeholder");
      if (labelledBy) return normalize(textByIds(labelledBy));
      if (ariaLabel) return normalize(ariaLabel);
      if (alt) return normalize(alt);
      if (title) return normalize(title);
      if (element instanceof HTMLInputElement) {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (type === "button" || type === "submit" || type === "reset") {
          return normalize(element.value);
        }
        if (placeholder) return normalize(placeholder);
      }
      if (isDomActionCandidate(element)) return domActionNameOf(element);
      return normalize(element.textContent);
    };
    const isDisabled = (element) =>
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.getAttribute("disabled") !== null;
    const matches = Array.from(document.querySelectorAll("*")).filter((element) => {
      if (!isVisible(element)) return false;
      return semanticRoleOf(element).toLowerCase() === targetRole && nameOf(element) === targetName;
    });
    const element = matches[targetNth];
    if (!element) {
      return {
        found: false,
        x: 0,
        y: 0,
        role: targetRole,
        name: targetName,
        disabled: false
      };
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      role: semanticRoleOf(element),
      name: nameOf(element),
      disabled: isDisabled(element)
    };
  })()`;
}
