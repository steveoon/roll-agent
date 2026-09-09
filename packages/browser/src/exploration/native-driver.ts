import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { clickElementRef, typeElementRef } from "../runtime/element-ref.ts";
import type { NativeCdpController, NativeCdpFrameTree } from "../runtime/native-cdp-controller.ts";
import type { BrowserElementRef } from "../types/index.ts";
import {
  BrowserScriptConditionSchema,
  BrowserScriptError,
  BrowserScriptLocatorSchema,
  BrowserChooseOptionsSchema,
  normalizeBrowserOrigin,
} from "./contracts.ts";
import {
  controlInspectionSchema,
  INSPECT_CONTROL,
  SELECT_NATIVE_OPTION,
  type ControlInspection,
} from "./control-inspector.ts";
import { assertFramePointUnoccluded } from "./frame-occlusion.ts";
import type {
  BrowserScriptCapability,
  BrowserScriptCondition,
  BrowserScriptLocator,
} from "./contracts.ts";

type DriverController = Pick<
  NativeCdpController,
  | "getFrameTree"
  | "getDocument"
  | "querySelectorAllByNodeId"
  | "describeNode"
  | "getFullAccessibilityTree"
  | "resolveBackendNode"
  | "callFunctionOnObject"
  | "releaseObject"
  | "dispatchMouseEvent"
  | "dispatchKeyEvent"
  | "insertText"
  | "preflightAction"
  | "getBoxModelByBackendNodeId"
  | "scrollIntoViewByBackendNodeId"
  | "evaluateJson"
  | "navigate"
  | "captureScreenshot"
>;

export type BrowserScriptPageDriverOptions = {
  controller: DriverController;
  pageId: string;
  browserInstance: string;
  allowedOrigins: readonly string[];
  capabilities: readonly BrowserScriptCapability[];
  signal?: AbortSignal;
  guard: (capability: BrowserScriptCapability) => Promise<void>;
  observe: (options?: { scope?: string }) => Promise<unknown>;
  resolveRef: (ref: string, snapshotId: string) => Promise<BrowserElementRef | undefined>;
  capture: (base64: string) => Promise<{ id: string; path: string; mimeType: "image/png" }>;
};

const attributeSchema = z.enum([
  "id",
  "name",
  "type",
  "role",
  "title",
  "placeholder",
  "href",
  "aria-label",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
]);
const optionsSchema = z.object({ expect: BrowserScriptConditionSchema.optional() }).strict();
const waitOptionsSchema = z
  .object({ timeoutMs: z.number().int().min(0).max(10_000).default(3000) })
  .strict();
const inspectSchema = z.object({
  attached: z.boolean(),
  visible: z.boolean(),
  enabled: z.boolean(),
  checked: z.boolean(),
  hit: z.boolean(),
  editable: z.boolean(),
  focused: z.boolean(),
  text: z.string().max(8000),
  value: z.string().max(8000).optional(),
  href: z.string().max(8000),
  navigationUrl: z.string().max(8000),
  documentUrl: z.string().max(8000),
  inScope: z.boolean(),
  scopeMatches: z.number(),
  attribute: z.string().max(8000).nullable().optional(),
});
type Inspection = z.infer<typeof inspectSchema>;
type ResolvedTarget = {
  backendNodeId: number;
  frameId: string;
  locator: BrowserScriptLocator;
  role: string;
  name: string;
};

// This is host-owned source; scripts supply only validated locators and attribute names as data.
const INSPECT_NODE = `function(scope, attribute, dispatchedPoint) {
  const el = this;
  const doc = el.ownerDocument;
  const view = doc && doc.defaultView;
  const attached = Boolean(el.isConnected && doc && view && el.nodeType === 1);
  if (!attached) return {attached:false,visible:false,enabled:false,checked:false,hit:false,editable:false,focused:false,text:'',href:'',navigationUrl:'',documentUrl:doc ? doc.URL : '',inScope:false,scopeMatches:0};
  const scopes = scope ? doc.querySelectorAll(scope) : [doc];
  const inScope = scopes.length === 1 && scopes[0].contains(el);
  const style = view.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  const x = dispatchedPoint ? dispatchedPoint.x : rect.left + rect.width / 2, y = dispatchedPoint ? dispatchedPoint.y : rect.top + rect.height / 2;
  const hitNode = doc.elementFromPoint(x,y);
  const hit = Boolean(hitNode && (hitNode === el || el.contains(hitNode)));
  const enabled = !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[inert]');
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const password = tag === 'input' && type === 'password';
  const editable = (tag === 'textarea' || (tag === 'input' && !['button','submit','reset','checkbox','radio','file','hidden','image'].includes(type)) || el.isContentEditable) && !el.readOnly;
  const anchor = el.closest('a[href]');
  const href = anchor ? anchor.href : '';
  const form = el.form;
  const submit = (tag === 'button' && (!type || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image'));
  const navigationUrl = href || (form && (submit || tag === 'input') ? (el.formAction || form.action) : '');
  const result = {attached,visible,enabled,checked:Boolean(el.checked || el.selected || el.getAttribute('aria-checked') === 'true'),hit,editable,focused:doc.activeElement === el || el.contains(doc.activeElement),text:String(password ? '' : (el.innerText || '')).slice(0,8000),href:String(href).slice(0,8000),navigationUrl:String(navigationUrl).slice(0,8000),documentUrl:String(doc.URL).slice(0,8000),inScope,scopeMatches:scopes.length};
  if (!password && typeof el.value === 'string') result.value = el.value.slice(0,8000);
  if (attribute) result.attribute = attribute === 'href' ? String(href).slice(0,8000) : (el.getAttribute(attribute) === null ? null : String(el.getAttribute(attribute)).slice(0,8000));
  return result;
}`;

const actualSchema = z.object({
  matched: z.number().int().nonnegative().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  text: z.string().max(500).optional(),
  value: z.string().max(500).optional(),
  url: z.string().max(500).optional(),
});
type ConditionActual = z.infer<typeof actualSchema>;
const metadataSchema = z.object({
  url: z.string().max(8000),
  title: z.string().max(160),
  dialogs: z.array(z.string().max(160)).max(10),
  focused: z
    .object({ tag: z.string().max(160), role: z.string().max(160), name: z.string().max(160) })
    .nullable(),
  scopeMatches: z.number().int().nonnegative(),
});
const OBSERVE_DOCUMENT = `function(scope) {
  const doc = this.nodeType === 9 ? this : this.ownerDocument;
  const view = doc.defaultView;
  const clean = (value) => String(value || '').replace(/\\s+/g,' ').trim().slice(0,160);
  const scopes = scope ? doc.querySelectorAll(scope) : [doc];
  const root = scopes.length === 1 ? scopes[0] : null;
  const visible = (el) => { const rect = el.getBoundingClientRect(); const style = view.getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; };
  const label = (el) => clean(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id=>doc.getElementById(id)?.textContent || '').join(' ') || el.getAttribute('title') || el.getAttribute('name'));
  const dialogs = root ? Array.from(root.querySelectorAll('[role="dialog"],dialog[open]')).filter(visible).slice(0,10).map(el=>label(el) || clean(el.querySelector('h1,h2,h3')?.textContent)) : [];
  const active = doc.activeElement;
  const focused = active && root && root.contains(active) ? {tag:clean(active.tagName.toLowerCase()),role:clean(active.getAttribute('role')),name:label(active)} : null;
  const location = new URL(doc.URL);
  return {url:location.origin+location.pathname,title:clean(doc.title),dialogs,focused,scopeMatches:scopes.length};
}`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function frames(tree: NativeCdpFrameTree): NativeCdpFrameTree[] {
  return [tree, ...(tree.childFrames ?? []).flatMap(frames)];
}
function axText(value: unknown): string {
  return record(value) && typeof value.value === "string" ? value.value : "";
}
function fail(code: string, message: string): never {
  throw new BrowserScriptError(code, message);
}

function boxPoint(model: Awaited<ReturnType<DriverController["getBoxModelByBackendNodeId"]>>): {
  x: number;
  y: number;
} {
  const quad = [model?.border, model?.content, model?.padding, model?.margin].find(
    (value) => value?.length === 8 && value.every(Number.isFinite),
  );
  if (!quad) fail("stale_target", "Target has no usable geometry");
  return {
    x: Math.round((quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4),
    y: Math.round((quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4),
  };
}

export class BrowserScriptPageDriver {
  readonly checks: Array<{
    passed: boolean;
    kind: string;
    elapsedMs: number;
    actual?: ConditionActual;
  }> = [];
  lastActionExecuted = false;
  lastVerification: "passed" | "failed" | "not_requested" = "not_requested";
  private readonly options: BrowserScriptPageDriverOptions;
  private closed = false;
  private boundaryFailure: unknown;
  private focused: ResolvedTarget | undefined;
  private lastConditionActual: ConditionActual | undefined;

  constructor(options: BrowserScriptPageDriverOptions) {
    this.options = options;
    if (!options.pageId || !options.browserInstance) {
      fail("invalid_target", "An explicit page and browser instance are required");
    }
  }

  close(): void {
    this.closed = true;
  }

  private allowed(url: string): void {
    let origin: string;
    try {
      origin = normalizeBrowserOrigin(url);
    } catch {
      fail("origin_blocked", "Target is not an allowed HTTP(S) page");
    }
    if (!this.options.allowedOrigins.includes(origin)) {
      fail("origin_blocked", "Target origin is outside the approved script origins");
    }
  }

  private async before(
    capability: BrowserScriptCapability,
    target?: ResolvedTarget,
  ): Promise<NativeCdpFrameTree> {
    if (this.boundaryFailure !== undefined) throw this.boundaryFailure;
    try {
      if (this.closed || this.options.signal?.aborted) {
        fail("cancelled", "Browser script was cancelled");
      }
      if (!this.options.capabilities.includes(capability)) {
        fail("capability_blocked", `Script did not declare ${capability}`);
      }
      await this.options.guard(capability);
      if (this.closed || this.options.signal?.aborted) {
        fail("cancelled", "Browser script was cancelled");
      }
      const tree = await this.options.controller.getFrameTree();
      this.allowed(tree.frame.url);
      if (target) {
        const frame = frames(tree).find((item) => item.frame.id === target.frameId);
        if (!frame) fail("stale_target", "Target frame no longer exists");
        this.allowed(frame.frame.url);
      }
      return tree;
    } catch (error) {
      this.boundaryFailure = error;
      throw error;
    }
  }

  private async inspect(
    target: ResolvedTarget,
    attribute?: z.infer<typeof attributeSchema>,
    point?: { x: number; y: number },
  ): Promise<Inspection> {
    const objectId = await this.options.controller.resolveBackendNode({
      backendNodeId: target.backendNodeId,
    });
    try {
      const scope = "scope" in target.locator ? target.locator.scope : undefined;
      const value = inspectSchema.parse(
        await this.options.controller.callFunctionOnObject({
          objectId,
          functionDeclaration: INSPECT_NODE,
          args: [scope ?? null, attribute ?? null, point ?? null],
        }),
      );
      this.allowed(value.documentUrl);
      if (scope && value.scopeMatches > 1) {
        fail("ambiguous_target", "Locator scope matched multiple elements");
      }
      return value;
    } finally {
      await this.options.controller.releaseObject(objectId).catch(() => {});
    }
  }

  private async frameRoot(frameId: string, mainFrameId: string): Promise<number> {
    const document = await this.options.controller.getDocument({
      depth: frameId === mainFrameId ? 0 : -1,
      pierce: true,
    });
    if (!record(document) || !record(document.root)) {
      fail("coverage_gap", "Page document is unavailable");
    }
    if (frameId === mainFrameId && typeof document.root.nodeId === "number") {
      return document.root.nodeId;
    }
    const pending: unknown[] = [document.root];
    let visited = 0;
    while (pending.length > 0 && visited++ < 20_000) {
      const item = pending.pop();
      if (!record(item)) continue;
      if (
        record(item.contentDocument) &&
        (item.frameId === frameId || item.contentDocument.frameId === frameId) &&
        typeof item.contentDocument.nodeId === "number"
      ) {
        return item.contentDocument.nodeId;
      }
      if (Array.isArray(item.children)) pending.push(...item.children);
      if (Array.isArray(item.shadowRoots)) pending.push(...item.shadowRoots);
      if (item.contentDocument) pending.push(item.contentDocument);
    }
    fail(
      "coverage_gap",
      "Frame DOM is outside this page connection; use an observed supported frame or visual inspection",
    );
  }

  private async targets(
    locator: BrowserScriptLocator,
    capability: BrowserScriptCapability,
  ): Promise<ResolvedTarget[]> {
    const tree = await this.before(capability);
    if ("ref" in locator) {
      const ref = await this.options.resolveRef(locator.ref, locator.snapshotId);
      if (!ref?.backendNodeId) {
        fail("stale_target", "Ref is not in the current page snapshot; observe again");
      }
      const target = {
        backendNodeId: ref.backendNodeId,
        frameId: ref.frameId ?? tree.frame.id,
        locator,
        role: ref.role,
        name: ref.name,
      };
      await this.before(capability, target);
      const inspection = await this.inspect(target);
      if (!inspection.attached) {
        fail("stale_target", "Ref points to a detached node; observe again");
      }
      return [target];
    }
    const frameId = locator.frameId ?? tree.frame.id;
    const frame = frames(tree).find((item) => item.frame.id === frameId);
    if (!frame) fail("stale_target", "Selected frame is unavailable");
    this.allowed(frame.frame.url);
    const found: ResolvedTarget[] = [];
    if ("css" in locator) {
      let nodeId = await this.frameRoot(frameId, tree.frame.id);
      if (locator.scope) {
        const scopes = await this.options.controller.querySelectorAllByNodeId({
          nodeId,
          selector: locator.scope,
        });
        if (scopes.length > 1) fail("ambiguous_target", "Locator scope matched multiple elements");
        if (scopes.length === 0) return [];
        nodeId = scopes[0]!;
      }
      const nodes = await this.options.controller.querySelectorAllByNodeId({
        nodeId,
        selector: locator.css,
      });
      if (nodes.length > 1000) {
        fail("observation_limit", "Locator matched too many elements; narrow its scope");
      }
      for (const id of nodes) {
        const node = await this.options.controller.describeNode({ nodeId: id });
        if (node.backendNodeId) {
          found.push({ backendNodeId: node.backendNodeId, frameId, locator, role: "", name: "" });
        }
      }
    } else {
      const nodes = await this.options.controller.getFullAccessibilityTree({ frameId });
      for (const node of nodes) {
        if (
          !record(node) ||
          node.ignored === true ||
          axText(node.role) !== locator.role ||
          axText(node.name) !== locator.name ||
          typeof node.backendDOMNodeId !== "number"
        ) {
          continue;
        }
        found.push({
          backendNodeId: node.backendDOMNodeId,
          frameId,
          locator,
          role: locator.role,
          name: locator.name,
        });
        if (found.length > 1000) fail("observation_limit", "Locator matched too many elements");
      }
    }
    const unique = [...new Map(found.map((target) => [target.backendNodeId, target])).values()];
    const matches: ResolvedTarget[] = [];
    for (const target of unique) {
      const inspection = await this.inspect(target);
      if (inspection.attached && inspection.inScope) matches.push(target);
    }
    return matches;
  }

  private async one(
    locator: BrowserScriptLocator,
    capability: BrowserScriptCapability,
  ): Promise<ResolvedTarget> {
    const targets = await this.targets(locator, capability);
    if (targets.length === 0) fail("target_not_found", "Locator matched no attached element");
    if (targets.length !== 1) {
      fail("ambiguous_target", "Locator matched multiple elements; add a scope");
    }
    return targets[0]!;
  }

  private async ready(
    target: ResolvedTarget,
    input: {
      hit?: boolean;
      editable?: boolean;
      focus?: boolean;
      navigation?: boolean;
      point?: { x: number; y: number };
    } = {},
  ): Promise<Inspection> {
    const tree = await this.before("interact", target);
    if (input.point) {
      const { x, y } = boxPoint(
        await this.options.controller.getBoxModelByBackendNodeId({
          backendNodeId: target.backendNodeId,
        }),
      );
      if (
        !Number.isFinite(input.point.x) ||
        !Number.isFinite(input.point.y) ||
        Math.abs(x - input.point.x) > 0.5 ||
        Math.abs(y - input.point.y) > 0.5
      ) {
        fail(
          "target_moved",
          "Target moved away from the outgoing input coordinates; observe again",
        );
      }
    }
    const value = await this.inspect(
      target,
      undefined,
      target.frameId === tree.frame.id ? input.point : undefined,
    );
    if ((input.hit || input.focus) && target.frameId !== tree.frame.id) {
      await assertFramePointUnoccluded(this.options.controller, {
        frameId: target.frameId,
        tree,
        point:
          input.point ??
          boxPoint(
            await this.options.controller.getBoxModelByBackendNodeId({
              backendNodeId: target.backendNodeId,
            }),
          ),
        allowedOrigins: this.options.allowedOrigins,
        requireFocus: input.focus === true,
        guard: async () => {
          await this.before("interact", target);
        },
      });
    }
    if (!value.attached || !value.inScope) {
      fail("stale_target", "Target was detached or moved outside its scope");
    }
    if (!value.enabled) fail("target_disabled", "Target is disabled");
    if (input.hit && (!value.visible || !value.hit)) {
      fail("target_occluded", "Target is hidden or covered by another element");
    }
    if (input.editable && !value.editable) {
      fail("target_not_editable", "Target is not an editable field");
    }
    if (input.focus && !value.focused) {
      fail("focus_changed", "Input focus no longer belongs to the selected target");
    }
    if (input.navigation && value.navigationUrl) {
      this.allowed(value.navigationUrl);
      await this.before("navigate", target);
    }
    return value;
  }

  private guardedController(
    target: ResolvedTarget,
    kind: "click" | "fill",
    validate?: () => Promise<void>,
  ) {
    const controller = this.options.controller;
    return {
      preflightAction: controller.preflightAction.bind(controller),
      evaluateJson: controller.evaluateJson.bind(controller),
      getFullAccessibilityTree: controller.getFullAccessibilityTree.bind(controller),
      getBoxModelByBackendNodeId: controller.getBoxModelByBackendNodeId.bind(controller),
      scrollIntoViewByBackendNodeId: async (
        input: Parameters<DriverController["scrollIntoViewByBackendNodeId"]>[0],
      ) => {
        await this.ready(target, { ...(kind === "fill" ? { editable: true } : {}) });
        this.lastActionExecuted = true;
        await controller.scrollIntoViewByBackendNodeId(input);
      },
      dispatchMouseEvent: async (input: Parameters<DriverController["dispatchMouseEvent"]>[0]) => {
        await validate?.();
        await this.ready(target, {
          hit: true,
          point: { x: input.x, y: input.y },
          navigation: kind === "click",
          ...(kind === "fill" ? { editable: true } : {}),
        });
        this.lastActionExecuted = true;
        await controller.dispatchMouseEvent(input);
      },
      dispatchKeyEvent: async (input: Parameters<DriverController["dispatchKeyEvent"]>[0]) => {
        await validate?.();
        await this.ready(target, { editable: true, focus: true });
        this.lastActionExecuted = true;
        await controller.dispatchKeyEvent(input);
      },
      insertText: async (text: string) => {
        await validate?.();
        await this.ready(target, { editable: true, focus: true });
        this.lastActionExecuted = true;
        await controller.insertText(text);
      },
    };
  }

  private ref(target: ResolvedTarget): BrowserElementRef {
    return {
      ref: "@e1",
      backendNodeId: target.backendNodeId,
      frameId: target.frameId,
      role: target.role,
      name: target.name,
      nth: 0,
      disabled: false,
      strict: true,
    };
  }

  private async action(method: "click" | "fill" | "hover", params: unknown[]): Promise<unknown> {
    const locator = BrowserScriptLocatorSchema.parse(params[0]);
    const text = method === "fill" ? z.string().max(16_000).parse(params[1]) : undefined;
    const options = optionsSchema.parse(params[method === "fill" ? 2 : 1] ?? {});
    const target = await this.one(locator, "interact");
    if (method === "hover") {
      await this.ready(target);
      this.lastActionExecuted = true;
      await this.options.controller.scrollIntoViewByBackendNodeId({
        backendNodeId: target.backendNodeId,
      });
      await this.ready(target, { hit: true });
      const point = boxPoint(
        await this.options.controller.getBoxModelByBackendNodeId({
          backendNodeId: target.backendNodeId,
        }),
      );
      await this.ready(target, { hit: true, point });
      await this.options.controller.dispatchMouseEvent({ type: "mouseMoved", ...point });
    } else {
      const controller = this.guardedController(target, method);
      if (method === "fill") {
        await typeElementRef({
          controller,
          elementRef: this.ref(target),
          text: text!,
          options: { clear: true },
        });
      } else await clickElementRef({ controller, elementRef: this.ref(target) });
      this.focused = target;
    }
    await this.afterExpectation(options.expect);
    return { executed: true, verification: this.lastVerification };
  }

  private async observeMetadata(scope?: string): Promise<unknown> {
    await this.before("read");
    const document = await this.options.controller.getDocument({ depth: 0 });
    if (!record(document) || !record(document.root)) {
      fail("coverage_gap", "Page document is unavailable");
    }
    let backendNodeId = document.root.backendNodeId;
    if (typeof backendNodeId !== "number" && typeof document.root.nodeId === "number") {
      backendNodeId = (await this.options.controller.describeNode({ nodeId: document.root.nodeId }))
        .backendNodeId;
    }
    if (typeof backendNodeId !== "number") {
      fail("coverage_gap", "Page document has no stable node identity");
    }
    const objectId = await this.options.controller.resolveBackendNode({ backendNodeId });
    try {
      const value = metadataSchema.parse(
        await this.options.controller.callFunctionOnObject({
          objectId,
          functionDeclaration: OBSERVE_DOCUMENT,
          args: [scope ?? null],
        }),
      );
      this.allowed(value.url);
      if (scope && value.scopeMatches !== 1) {
        fail(
          value.scopeMatches > 1 ? "ambiguous_target" : "target_not_found",
          "Observation scope must match exactly one region",
        );
      }
      await this.before("read");
      return { url: value.url, title: value.title, dialogs: value.dialogs, focused: value.focused };
    } finally {
      await this.options.controller.releaseObject(objectId).catch(() => {});
    }
  }

  private async condition(condition: BrowserScriptCondition): Promise<boolean> {
    this.lastConditionActual = undefined;
    if ("url" in condition) {
      const tree = await this.before("read");
      const url = new URL(tree.frame.url);
      this.lastConditionActual = { url: (url.origin + url.pathname).slice(0, 500) };
      return condition.match === "startsWith"
        ? tree.frame.url.startsWith(condition.url)
        : tree.frame.url === condition.url;
    }
    const matches = await this.targets(condition.target, "read");
    this.lastConditionActual = { matched: matches.length };
    if (matches.length > 1) {
      fail("ambiguous_target", "Verification locator matched multiple elements");
    }
    if (matches.length === 0) {
      return "state" in condition && ["absent", "hidden"].includes(condition.state);
    }
    const value = await this.inspect(matches[0]!);
    this.lastConditionActual = {
      matched: matches.length,
      visible: value.visible,
      enabled: value.enabled,
      checked: value.checked,
      ...("text" in condition ? { text: value.text.slice(0, 500) } : {}),
      ...("value" in condition && value.value !== undefined
        ? { value: value.value.slice(0, 500) }
        : {}),
    };
    if ("text" in condition) {
      return condition.match === "contains"
        ? value.text.includes(condition.text)
        : value.text === condition.text;
    }
    if ("value" in condition) return value.value !== undefined && value.value === condition.value;
    const states: Record<typeof condition.state, boolean> = {
      attached: value.attached,
      absent: !value.attached,
      visible: value.visible,
      hidden: !value.visible,
      enabled: value.enabled,
      disabled: !value.enabled,
      checked: value.checked,
      unchecked: !value.checked,
    };
    return states[condition.state];
  }

  private async waitFor(condition: BrowserScriptCondition, timeoutMs: number): Promise<unknown> {
    const start = Date.now();
    let passed = false;
    let failure: unknown;
    try {
      do {
        passed = await this.condition(condition);
        if (passed || Date.now() - start >= timeoutMs) break;
        await delay(
          Math.min(100, Math.max(1, timeoutMs - (Date.now() - start))),
          undefined,
          this.options.signal ? { signal: this.options.signal } : {},
        );
      } while (!passed);
    } catch (error) {
      failure = error;
    }
    const last = this.lastConditionActual;
    const actual =
      passed && last
        ? {
            ...(last.matched !== undefined ? { matched: last.matched } : {}),
            ...(last.visible !== undefined ? { visible: last.visible } : {}),
            ...(last.enabled !== undefined ? { enabled: last.enabled } : {}),
            ...(last.checked !== undefined ? { checked: last.checked } : {}),
          }
        : last;
    this.checks.push({
      passed,
      kind:
        "url" in condition
          ? "url"
          : "state" in condition
            ? condition.state
            : "text" in condition
              ? "text"
              : "value",
      elapsedMs: Date.now() - start,
      ...(actual ? { actual: actualSchema.parse(actual) } : {}),
    });
    this.lastVerification = passed ? "passed" : "failed";
    if (failure !== undefined) throw failure;
    if (!passed) {
      fail("verification_failed", "Expected page condition was not satisfied before its deadline");
    }
    return { passed: true };
  }

  private async afterExpectation(condition?: BrowserScriptCondition): Promise<void> {
    if (condition) await this.waitFor(condition, 3000);
    else await this.before("interact");
  }

  private async control(target: ResolvedTarget, panel?: string): Promise<ControlInspection> {
    await this.before("read", target);
    const field = await this.inspect(target);
    if (!field.attached || !field.inScope) {
      fail("stale_target", "Control was replaced or left its scope");
    }
    const objectId = await this.options.controller.resolveBackendNode({
      backendNodeId: target.backendNodeId,
    });
    try {
      const info = controlInspectionSchema.parse(
        await this.options.controller.callFunctionOnObject({
          objectId,
          functionDeclaration: INSPECT_CONTROL,
          args: [panel ?? null],
        }),
      );
      await this.before("read", target);
      return info;
    } finally {
      await this.options.controller.releaseObject(objectId).catch(() => {});
    }
  }

  private async choose(params: unknown[]): Promise<unknown> {
    const locator = BrowserScriptLocatorSchema.parse(params[0]);
    const options = BrowserChooseOptionsSchema.parse(params[1]);
    const target = await this.one(locator, "interact");
    const deadline = Date.now() + options.timeoutMs;
    const began = performance.now();
    let info = await this.control(target, options.panel);
    const initial = info;
    const actual: ConditionActual = { matched: 0 };
    try {
      if (info.multiple) {
        fail("unsupported_control", "Multi-select requires explicit per-option orchestration");
      }
      if (!info.triggerCss || info.kind === "unknown") {
        fail("unsupported_control", "No unique control trigger was found");
      }
      if (info.association === "ambiguous") {
        fail("ambiguous_target", "Control panel association is ambiguous; specify panel");
      }
      if (info.kind !== "native" && !info.expanded) {
        await this.action("click", [{ css: info.triggerCss, frameId: target.frameId }]);
        do {
          info = await this.control(target, options.panel);
          if (info.association === "ambiguous") {
            fail("ambiguous_target", "Multiple panels appeared; specify panel");
          }
          if (info.expanded && info.options.length) break;
          await delay(50);
        } while (Date.now() < deadline);
      }
      if (info.association === "none") {
        fail(
          "control_unassociated",
          "No associated panel; inspect and specify a unique panel region",
        );
      }
      if (info.multiple) {
        fail("unsupported_control", "Multi-select requires explicit per-option orchestration");
      }
      const matches = info.options.filter((option) =>
        options.label === undefined
          ? option.value === options.value
          : option.label === options.label.trim().replace(/\s+/g, " "),
      );
      actual.matched = matches.length;
      if (info.coverageWarnings.includes("options_truncated")) {
        fail(
          "coverage_gap",
          "Options were truncated; narrow the panel or explicitly explore the list",
        );
      }
      if (matches.length !== 1) {
        fail(
          matches.length ? "ambiguous_target" : "target_not_found",
          "Choice must match exactly one rendered option",
        );
      }
      if (Date.now() >= deadline) {
        fail("verification_failed", "Control deadline expired before selection");
      }
      const option = matches[0]!;
      if (option.disabled) fail("target_disabled", "Choice is disabled");
      if (!option.selected) {
        if (info.kind === "native") {
          const nativeTarget = await this.one(
            { css: info.triggerCss!, frameId: target.frameId },
            "interact",
          );
          await this.ready(nativeTarget);
          this.lastActionExecuted = true;
          await this.options.controller.scrollIntoViewByBackendNodeId({
            backendNodeId: nativeTarget.backendNodeId,
          });
          await this.ready(nativeTarget, { hit: true });
          const objectId = await this.options.controller.resolveBackendNode({
            backendNodeId: nativeTarget.backendNodeId,
          });
          try {
            await this.control(target, options.panel);
            await this.ready(nativeTarget, { hit: true });
            if (Date.now() >= deadline) {
              fail("verification_failed", "Control deadline expired before selection");
            }
            this.lastActionExecuted = true;
            const changed = await this.options.controller.callFunctionOnObject({
              objectId,
              functionDeclaration: SELECT_NATIVE_OPTION,
              args: [options.label ?? null, options.value ?? null],
            });
            if (changed !== true) fail("stale_target", "Native select changed before selection");
          } finally {
            await this.options.controller.releaseObject(objectId).catch(() => {});
          }
        } else {
          const optionTarget = await this.one(
            { css: option.css, frameId: target.frameId },
            "interact",
          );
          const current = await this.control(target, options.panel);
          if (
            !current.options.some(
              (row) =>
                row.css === option.css &&
                row.label === option.label &&
                row.value === option.value &&
                !row.disabled,
            )
          ) {
            fail("stale_target", "Choice changed before input");
          }
          // Bind the selected backend node; do not re-resolve a positional selector during input.
          const validate = async () => {
            if (Date.now() >= deadline) {
              fail("verification_failed", "Control deadline expired before input");
            }
            const current = await this.control(target, options.panel);
            const rebound = await this.targets(
              { css: option.css, frameId: target.frameId },
              "interact",
            );
            if (
              rebound.length !== 1 ||
              rebound[0]!.backendNodeId !== optionTarget.backendNodeId ||
              !current.options.some(
                (row) =>
                  row.css === option.css &&
                  row.label === option.label &&
                  row.value === option.value &&
                  !row.disabled,
              )
            ) {
              fail("stale_target", "Choice identity or label changed before input");
            }
          };
          await clickElementRef({
            controller: this.guardedController(optionTarget, "click", validate),
            elementRef: this.ref(optionTarget),
          });
        }
      }
      let verified = false;
      do {
        const current = await this.control(target, options.panel);
        const selected = current.options.filter(
          (row) =>
            row.selected &&
            (options.label === undefined
              ? row.value === option.value
              : row.label === option.label.trim().replace(/\s+/g, " ")),
        );
        verified =
          selected.length === 1 ||
          (info.kind !== "native" &&
            ((options.value !== undefined &&
              option.value !== null &&
              current.value === option.value &&
              initial.value !== current.value) ||
              (options.label !== undefined &&
                current.text.trim() === option.label.trim().replace(/\s+/g, " ") &&
                initial.text !== current.text)));
        if (verified) break;
        if (options.expect) {
          await this.waitFor(options.expect, Math.max(0, deadline - Date.now()));
          verified = true;
          break;
        }
        await delay(50);
      } while (Date.now() < deadline);
      if (!verified) {
        fail(
          "verification_failed",
          "Choice click did not establish selected state or the expected field result",
        );
      }
      if (options.expect) await this.waitFor(options.expect, Math.max(0, deadline - Date.now()));
      this.checks.push({ passed: true, kind: "selection", elapsedMs: performance.now() - began });
      this.lastVerification = "passed";
      return {
        executed: this.lastActionExecuted,
        verification: "passed",
        label: option.label,
        frameId: target.frameId,
      };
    } catch (error) {
      this.lastVerification = "failed";
      this.checks.push({
        passed: false,
        kind: "selection",
        elapsedMs: performance.now() - began,
        actual,
      });
      throw error;
    }
  }

  async invoke(method: string, params: unknown[]): Promise<unknown> {
    this.lastActionExecuted = false;
    this.lastVerification = "not_requested";
    if (params.length > 3) fail("invalid_arguments", "Too many browser helper arguments");
    const handlers: Record<string, () => Promise<unknown>> = {
      inspectControl: async () => {
        const target = await this.one(BrowserScriptLocatorSchema.parse(params[0]), "read");
        const options = z
          .object({ panel: z.string().min(1).max(2000).optional() })
          .strict()
          .parse(params[1] ?? {});
        return {
          ...(await this.control(target, options.panel)),
          frameId: target.frameId,
          pageId: this.options.pageId,
        };
      },
      choose: async () => await this.choose(params),
      snapshot: async () => {
        const options = z
          .object({ scope: z.string().min(1).max(2000).optional() })
          .strict()
          .parse(params[0] ?? {});
        await this.before("read");
        const result = await this.options.observe(
          options.scope === undefined ? {} : { scope: options.scope },
        );
        await this.before("read");
        return result;
      },
      observe: async () => {
        const options = z
          .object({ scope: z.string().min(1).max(2000).optional() })
          .strict()
          .parse(params[0] ?? {});
        return await this.observeMetadata(options.scope);
      },
      read: async () => {
        const target = await this.one(BrowserScriptLocatorSchema.parse(params[0]), "read");
        const options = z
          .object({ attribute: attributeSchema.optional() })
          .strict()
          .parse(params[1] ?? {});
        const value = await this.inspect(target, options.attribute);
        if (!value.attached || !value.inScope) {
          fail("stale_target", "Read target changed during inspection");
        }
        const { text, href, visible, enabled, checked } = value;
        return {
          text,
          href,
          visible,
          enabled,
          checked,
          ...(value.value !== undefined ? { value: value.value } : {}),
          ...(options.attribute
            ? { attributes: { [options.attribute]: value.attribute ?? null } }
            : {}),
        };
      },
      exists: async () =>
        (await this.targets(BrowserScriptLocatorSchema.parse(params[0]), "read")).length > 0,
      count: async () =>
        (await this.targets(BrowserScriptLocatorSchema.parse(params[0]), "read")).length,
      click: async () => await this.action("click", params),
      fill: async () => await this.action("fill", params),
      hover: async () => await this.action("hover", params),
      waitFor: async () =>
        await this.waitFor(
          BrowserScriptConditionSchema.parse(params[0]),
          waitOptionsSchema.parse(params[1] ?? {}).timeoutMs,
        ),
      expect: async () => await handlers.waitFor!(),
      press: async () => {
        const key = z
          .enum([
            "Enter",
            "Escape",
            "Tab",
            "Backspace",
            "Delete",
            "ArrowDown",
            "ArrowUp",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Space",
          ])
          .parse(params[0]);
        const options = optionsSchema
          .extend({ target: BrowserScriptLocatorSchema.optional() })
          .parse(params[1] ?? {});
        const target = options.target ? await this.one(options.target, "interact") : this.focused;
        if (!target) {
          fail(
            "focus_required",
            "Press requires an explicit target or a target focused by this script",
          );
        }
        if (options.target) {
          await clickElementRef({
            controller: this.guardedController(target, "click"),
            elementRef: this.ref(target),
          });
          this.focused = target;
        }
        const keyCodes: Record<typeof key, number> = {
          Enter: 13,
          Escape: 27,
          Tab: 9,
          Backspace: 8,
          Delete: 46,
          ArrowDown: 40,
          ArrowUp: 38,
          ArrowLeft: 37,
          ArrowRight: 39,
          Home: 36,
          End: 35,
          Space: 32,
        };
        for (const type of ["rawKeyDown", "keyUp"] as const) {
          await this.ready(target, { focus: type === "rawKeyDown", navigation: key === "Enter" });
          this.lastActionExecuted = true;
          await this.options.controller.dispatchKeyEvent({
            type,
            key: key === "Space" ? " " : key,
            code: key,
            windowsVirtualKeyCode: keyCodes[key],
          });
        }
        await this.afterExpectation(options.expect);
        return { executed: true, verification: this.lastVerification };
      },
      scroll: async () => {
        const target = await this.one(BrowserScriptLocatorSchema.parse(params[0]), "interact");
        const options = optionsSchema
          .extend({
            dx: z.number().finite().min(-2000).max(2000).default(0),
            dy: z.number().finite().min(-2000).max(2000).default(0),
          })
          .parse(params[1] ?? {});
        await this.ready(target);
        this.lastActionExecuted = true;
        await this.options.controller.scrollIntoViewByBackendNodeId({
          backendNodeId: target.backendNodeId,
        });
        await this.ready(target, { hit: true });
        const point = boxPoint(
          await this.options.controller.getBoxModelByBackendNodeId({
            backendNodeId: target.backendNodeId,
          }),
        );
        await this.ready(target, { hit: true, point });
        await this.options.controller.dispatchMouseEvent({ type: "mouseMoved", ...point });
        await this.ready(target, { hit: true, point });
        await this.options.controller.dispatchMouseEvent({
          type: "mouseWheel",
          ...point,
          deltaX: options.dx,
          deltaY: options.dy,
        });
        await this.afterExpectation(options.expect);
        return { executed: true, verification: this.lastVerification };
      },
      goto: async () => {
        const url = z.string().url().max(8000).parse(params[0]);
        const options = optionsSchema.parse(params[1] ?? {});
        this.allowed(url);
        await this.before("navigate");
        this.lastActionExecuted = true;
        const result = await this.options.controller.navigate(url);
        if (result.errorText) fail("navigation_failed", "Browser navigation failed");
        await this.before("navigate");
        if (options.expect) await this.waitFor(options.expect, 3000);
        return { executed: true, verification: this.lastVerification };
      },
      screenshot: async () => {
        await this.before("capture");
        const base64 = await this.options.controller.captureScreenshot({
          format: "png",
          captureBeyondViewport: false,
        });
        await this.before("capture");
        return await this.options.capture(base64);
      },
    };
    if (!Object.hasOwn(handlers, method)) fail("unknown_helper", "Unknown browser helper");
    return await handlers[method]!();
  }
}
