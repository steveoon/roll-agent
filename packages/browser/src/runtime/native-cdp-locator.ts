import { setTimeout as delay } from "node:timers/promises";
import type { NativeCdpController, NativeCdpMouseEventInput } from "./native-cdp-controller.ts";

const DEFAULT_NATIVE_LOCATOR_POLL_MS = 250;
const DEFAULT_NATIVE_LOCATOR_TIMEOUT_MS = 5_000;
const DEFAULT_NATIVE_CLICK_SETTLE_MS = 250;

export type NativeCdpRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type NativeCdpLocatorOptions = {
  readonly rootSelector?: string;
  readonly index?: number;
};

export type NativeCdpLocatorTarget = {
  readonly found: boolean;
  readonly selector: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly tagName: string;
  readonly text: string;
  readonly role: string;
  readonly href: string;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly rect: NativeCdpRect | null;
  readonly hitTagName: string;
  readonly hitText: string;
};

export type NativeCdpLocatorWaitOptions = {
  readonly state?: "attached" | "visible";
  readonly timeoutMs?: number;
  readonly pollMs?: number;
};

export type NativeCdpLocatorClickOptions = {
  readonly button?: NativeCdpMouseEventInput["button"];
  readonly clickCount?: number;
  readonly timeoutMs?: number;
  readonly settleMs?: number;
  readonly onTargetResolved?: (target: NativeCdpLocatorTarget) => Promise<void> | void;
};

export type NativeCdpLocatorClickResult = {
  readonly success: boolean;
  readonly reason?: "not_found" | "not_visible" | "disabled";
  readonly target?: NativeCdpLocatorTarget;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requireBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function toNativeRect(value: unknown): NativeCdpRect | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    x: requireNumber(value["x"]),
    y: requireNumber(value["y"]),
    width: requireNumber(value["width"]),
    height: requireNumber(value["height"]),
    left: requireNumber(value["left"]),
    top: requireNumber(value["top"]),
    right: requireNumber(value["right"]),
    bottom: requireNumber(value["bottom"]),
  };
}

function toLocatorTarget(value: unknown, selector: string, index: number): NativeCdpLocatorTarget {
  if (!isRecord(value)) {
    return {
      found: false,
      selector,
      index,
      x: 0,
      y: 0,
      tagName: "",
      text: "",
      role: "",
      href: "",
      visible: false,
      disabled: false,
      rect: null,
      hitTagName: "",
      hitText: "",
    };
  }

  return {
    found: requireBoolean(value["found"]),
    selector: requireString(value["selector"]) || selector,
    index:
      typeof value["index"] === "number" && Number.isInteger(value["index"])
        ? value["index"]
        : index,
    x: requireNumber(value["x"]),
    y: requireNumber(value["y"]),
    tagName: requireString(value["tagName"]),
    text: requireString(value["text"]),
    role: requireString(value["role"]),
    href: requireString(value["href"]),
    visible: requireBoolean(value["visible"]),
    disabled: requireBoolean(value["disabled"]),
    rect: toNativeRect(value["rect"]),
    hitTagName: requireString(value["hitTagName"]),
    hitText: requireString(value["hitText"]),
  };
}

export class NativeCdpLocator {
  private readonly controller: NativeCdpController;
  private readonly selector: string;
  private readonly rootSelector: string | undefined;
  private readonly index: number;

  constructor(
    controller: NativeCdpController,
    selector: string,
    options: NativeCdpLocatorOptions = {},
  ) {
    this.controller = controller;
    this.selector = selector;
    this.rootSelector = options.rootSelector;
    this.index = options.index ?? 0;
  }

  first(): NativeCdpLocator {
    return this.nth(0);
  }

  nth(index: number): NativeCdpLocator {
    return new NativeCdpLocator(this.controller, this.selector, {
      ...(this.rootSelector !== undefined ? { rootSelector: this.rootSelector } : {}),
      index,
    });
  }

  async count(): Promise<number> {
    return await this.controller.evaluateJson<number>(this.buildExpression("count"));
  }

  async isVisible(): Promise<boolean> {
    const target = await this.resolveTarget();
    return target.found && target.visible;
  }

  async textContent(): Promise<string> {
    const target = await this.resolveTarget();
    return target.text;
  }

  async boundingBox(): Promise<NativeCdpRect | null> {
    const target = await this.resolveTarget();
    return target.rect;
  }

  async waitFor(options: NativeCdpLocatorWaitOptions = {}): Promise<boolean> {
    const state = options.state ?? "visible";
    const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_LOCATOR_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_NATIVE_LOCATOR_POLL_MS;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const target = await this.resolveTarget().catch(() => undefined);
      if (target?.found && (state === "attached" || target.visible)) {
        return true;
      }
      await delay(pollMs);
    }

    const target = await this.resolveTarget().catch(() => undefined);
    return target?.found === true && (state === "attached" || target.visible);
  }

  async click(options: NativeCdpLocatorClickOptions = {}): Promise<NativeCdpLocatorClickResult> {
    const target = await this.resolveTarget({
      scrollIntoView: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!target.found) {
      return { success: false, reason: "not_found", target };
    }
    if (!target.visible) {
      return { success: false, reason: "not_visible", target };
    }
    if (target.disabled) {
      return { success: false, reason: "disabled", target };
    }

    await options.onTargetResolved?.(target);
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;

    await this.controller.dispatchMouseEvent({
      type: "mouseMoved",
      x: target.x,
      y: target.y,
      buttons: 0,
    });
    await this.controller.dispatchMouseEvent({
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button,
      buttons: button === "left" ? 1 : 0,
      clickCount,
    });
    await this.controller.dispatchMouseEvent({
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button,
      buttons: 0,
      clickCount,
    });

    await delay(options.settleMs ?? DEFAULT_NATIVE_CLICK_SETTLE_MS);
    return { success: true, target };
  }

  private async resolveTarget(options: { readonly scrollIntoView?: boolean; readonly timeoutMs?: number } = {}) {
    return toLocatorTarget(
      await this.controller.evaluateJson(
        this.buildExpression(options.scrollIntoView ? "targetWithScroll" : "target"),
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      ),
      this.selector,
      this.index,
    );
  }

  private buildExpression(mode: "count" | "target" | "targetWithScroll"): string {
    return `(() => {
      const selector = ${JSON.stringify(this.selector)};
      const rootSelector = ${JSON.stringify(this.rootSelector ?? "")};
      const index = ${JSON.stringify(this.index)};
      const mode = ${JSON.stringify(mode)};

      const emptyTarget = {
        found: false,
        selector,
        index,
        x: 0,
        y: 0,
        tagName: "",
        text: "",
        role: "",
        href: "",
        visible: false,
        disabled: false,
        rect: null,
        hitTagName: "",
        hitText: ""
      };

      const root = rootSelector ? document.querySelector(rootSelector) : document;
      if (!root) return mode === "count" ? 0 : emptyTarget;

      let elements = [];
      try {
        elements = Array.from(root.querySelectorAll(selector));
      } catch {
        return mode === "count" ? 0 : emptyTarget;
      }

      if (mode === "count") return elements.length;
      const element = elements[index];
      if (!element) return emptyTarget;
      if (mode === "targetWithScroll") {
        element.scrollIntoView({ block: "center", inline: "center" });
      }

      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const disabled =
        element.matches(":disabled") ||
        element.getAttribute("aria-disabled") === "true" ||
        element.getAttribute("disabled") !== null;
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = visible ? document.elementFromPoint(x, y) : null;

      return {
        found: true,
        selector,
        index,
        x,
        y,
        tagName: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").trim().slice(0, 500),
        role: element.getAttribute("role") ?? "",
        href: element instanceof HTMLAnchorElement ? element.href : "",
        visible,
        disabled,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom
        },
        hitTagName: hit?.tagName.toLowerCase() ?? "",
        hitText: (hit?.textContent ?? "").trim().slice(0, 500)
      };
    })()`;
  }
}
