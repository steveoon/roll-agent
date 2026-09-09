import {
  assertFramePointUnoccluded,
  BrowserScriptError,
  isUrlAllowedByDomainAllowlist,
  normalizeBrowserOrigin,
} from "@roll-agent/browser";
import type {
  BrowserRuntime,
  NativeCdpController,
  NativeCdpMouseEventInput,
  NativeCdpKeyEventInput,
} from "@roll-agent/browser";
import { StructuredToolError } from "@roll-agent/sdk";

/** Preserve native method receivers while checking the last, externally observable input boundary. */
export function createBrowserRefFrameGuard(
  controller: NativeCdpController,
  input: {
    frameId?: string;
    runtime: Pick<BrowserRuntime, "getConfig">;
    approvedByConfirmation: boolean;
    signal?: AbortSignal;
  },
): NativeCdpController {
  if (!input.frameId) return controller;
  const frameId = input.frameId;
  let lastPoint: { x: number; y: number } | undefined;
  const policyGuard = async () => {
    if (input.signal?.aborted) {
      throw new StructuredToolError({ code: "cancelled", message: "Browser action cancelled." });
    }
    const security = input.runtime.getConfig().security;
    if (
      security.actionPolicy === "deny" ||
      (security.actionPolicy === "confirm" && !input.approvedByConfirmation)
    ) {
      throw new StructuredToolError({
        code: "action_denied",
        message: "Browser action policy changed; take no further action.",
      });
    }
  };
  const inspect = async (point: { x: number; y: number }, requireFocus: boolean) => {
    await policyGuard();
    const tree = await controller.getFrameTree();
    await policyGuard();
    if (frameId === tree.frame.id) return;
    let origin: string;
    try {
      origin = normalizeBrowserOrigin(tree.frame.url);
    } catch {
      throw new StructuredToolError({
        code: "coverage_gap",
        message: "Cannot determine the ancestor document origin.",
      });
    }
    const guard = async () => {
      await policyGuard();
      if (
        !isUrlAllowedByDomainAllowlist(origin, input.runtime.getConfig().security.domainAllowlist)
      ) {
        throw new StructuredToolError({
          code: "domain_denied",
          message: "The frame ancestor is outside the current domain allowlist.",
        });
      }
    };
    try {
      await assertFramePointUnoccluded(controller, {
        frameId,
        tree,
        point,
        allowedOrigins: [origin],
        requireFocus,
        guard,
      });
    } catch (error) {
      if (error instanceof BrowserScriptError) {
        throw new StructuredToolError({ code: error.code, message: error.message });
      }
      throw error;
    }
  };
  const dispatchMouseEvent = async (event: NativeCdpMouseEventInput) => {
    if (event.type === "mousePressed" || event.type === "mouseReleased") {
      await inspect(event, false);
      lastPoint = { x: event.x, y: event.y };
    }
    await controller.dispatchMouseEvent(event);
  };
  const beforeText = async () => {
    if (!lastPoint) {
      throw new StructuredToolError({
        code: "focus_changed",
        message: "No verified frame focus target is available.",
      });
    }
    await inspect(lastPoint, true);
  };
  const dispatchKeyEvent = async (event: NativeCdpKeyEventInput) => {
    await beforeText();
    await controller.dispatchKeyEvent(event);
  };
  const insertText = async (text: string) => {
    await beforeText();
    await controller.insertText(text);
  };
  return new Proxy(controller, {
    get(target, property) {
      if (property === "dispatchMouseEvent") return dispatchMouseEvent;
      if (property === "dispatchKeyEvent") return dispatchKeyEvent;
      if (property === "insertText") return insertText;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
