import type { ChatNotice } from "./notice.ts";

export interface ChatFastModeControl {
  /** Whether the current provider offers the Fast control, independent of on/off state. */
  isAvailable(): boolean;
  getEnabled(): boolean;
  /** Pending target, falling back to the applied state when no change is in flight. */
  getRequestedEnabled(): boolean;
  /** False means a newer request superseded this change before it could be applied. */
  setEnabled(enabled: boolean): Promise<boolean>;
}

export function createChatFastModeControl(options: {
  isAvailable?(): boolean;
  getEnabled(): boolean;
  prepareEnable(): Promise<void>;
  apply(enabled: boolean): void;
}): ChatFastModeControl {
  let revision = 0;
  let requestedEnabled: boolean | undefined;
  return {
    isAvailable: () => options.isAvailable?.() ?? true,
    getEnabled: () => options.getEnabled(),
    getRequestedEnabled: () => requestedEnabled ?? options.getEnabled(),
    setEnabled: async (enabled) => {
      const requestedRevision = ++revision;
      requestedEnabled = enabled;
      try {
        if (enabled) await options.prepareEnable();
        if (requestedRevision !== revision) return false;
        options.apply(enabled);
        return true;
      } catch (error) {
        if (requestedRevision !== revision) return false;
        throw error;
      } finally {
        if (requestedRevision === revision) requestedEnabled = undefined;
      }
    },
  };
}

export async function runFastModeCommand(
  argument: string,
  control?: ChatFastModeControl,
): Promise<ChatNotice | undefined> {
  const value = argument.trim().toLowerCase();
  if (value !== "" && value !== "on" && value !== "off") {
    return { tone: "warning", text: "用法: /fast [on | off]" };
  }
  if (!control) return { tone: "warning", text: "当前入口不支持切换 Fast 模式。" };
  const enabled = value === "" ? !control.getRequestedEnabled() : value === "on";
  try {
    if (!(await control.setEnabled(enabled))) return undefined;
    return {
      tone: "info",
      text: enabled
        ? "Fast 已开启：后续 ChatGPT 请求将优先加速，可能增加订阅额度消耗。"
        : "Fast 已关闭。",
    };
  } catch (error) {
    return {
      tone: "warning",
      text: `Fast 切换失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
