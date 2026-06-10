import { isVisualActivityEnabled } from "../visual-activity.ts";

type NativePreviewTarget = {
  evaluateJson<T = unknown>(expression: string): Promise<T>;
};

function buildPreviewScript(input: {
  readonly mode: "begin" | "status" | "draft" | "final" | "complete" | "fail" | "clear";
  readonly label?: string;
  readonly locationSummary?: string;
  readonly draftText?: string;
  readonly provisional?: boolean;
}): string {
  return `(() => {
    const input = ${JSON.stringify(input)};
    const rootId = "roll-agent-reply-preview-root";
    const statusId = "roll-agent-reply-preview-status";
    const draftId = "roll-agent-reply-preview-draft";
    const badgeId = "roll-agent-reply-preview-badge";
    const locationId = "roll-agent-reply-preview-location";
    const spinnerId = "roll-agent-reply-preview-spinner";
    const styleId = "roll-agent-reply-preview-style";
    const stateKey = "__rollAgentReplyPreviewState";
    const state = window[stateKey] || {};
    window[stateKey] = state;

    const cancelPendingRemove = () => {
      if (state.removeTimer) {
        window.clearTimeout(state.removeTimer);
        state.removeTimer = undefined;
      }
    };

    if (input.mode === "clear") {
      const existingRoot = document.getElementById(rootId);
      if (!existingRoot) return true;

      cancelPendingRemove();
      existingRoot.style.opacity = "0";
      existingRoot.style.transform = "translateY(8px) scale(0.98)";
      state.removeTimer = window.setTimeout(() => {
        if (document.getElementById(rootId) === existingRoot) {
          existingRoot.remove();
        }
        state.removeTimer = undefined;
      }, 240);
      return true;
    }

    const ensureRoot = () => {
      let root = document.getElementById(rootId);
      if (root) {
        cancelPendingRemove();
        return root;
      }

      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = "@keyframes rollAgentReplyPreviewSpin { to { transform: rotate(360deg); } }";
        document.head.append(style);
      }

      root = document.createElement("div");
      root.id = rootId;
      root.style.position = "fixed";
      root.style.right = "20px";
      root.style.bottom = "20px";
      root.style.width = "min(420px, calc(100vw - 40px))";
      root.style.maxHeight = "42vh";
      root.style.zIndex = "2147483646";
      root.style.pointerEvents = "none";
      root.style.display = "flex";
      root.style.flexDirection = "column";
      root.style.gap = "10px";
      root.style.padding = "14px";
      root.style.borderRadius = "16px";
      root.style.border = "1px solid rgba(45, 212, 191, 0.32)";
      root.style.background = "rgba(15, 23, 42, 0.88)";
      root.style.color = "#F8FAFC";
      root.style.boxShadow = "0 22px 58px rgba(15, 23, 42, 0.34)";
      root.style.backdropFilter = "blur(14px)";
      root.style.fontFamily =
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      root.style.opacity = "0";
      root.style.transform = "translateY(8px)";
      root.style.transition = "opacity 180ms ease, transform 220ms ease";

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.gap = "8px";
      header.style.minWidth = "0";

      const spinner = document.createElement("div");
      spinner.id = spinnerId;
      spinner.setAttribute("aria-hidden", "true");
      spinner.style.width = "14px";
      spinner.style.height = "14px";
      spinner.style.flex = "0 0 auto";
      spinner.style.borderRadius = "999px";
      spinner.style.border = "2px solid rgba(153, 246, 228, 0.24)";
      spinner.style.borderTopColor = "#99F6E4";
      spinner.style.animation = "rollAgentReplyPreviewSpin 820ms linear infinite";
      spinner.style.transition =
        "border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease";

      const status = document.createElement("div");
      status.id = statusId;
      status.style.minWidth = "0";
      status.style.fontSize = "13px";
      status.style.fontWeight = "700";
      status.style.lineHeight = "18px";
      status.style.overflow = "hidden";
      status.style.textOverflow = "ellipsis";
      status.style.whiteSpace = "nowrap";

      const badge = document.createElement("div");
      badge.id = badgeId;
      badge.style.alignSelf = "flex-start";
      badge.style.fontSize = "11px";
      badge.style.lineHeight = "16px";
      badge.style.padding = "3px 8px";
      badge.style.borderRadius = "999px";
      badge.style.background = "rgba(20, 184, 166, 0.18)";
      badge.style.color = "#99F6E4";
      badge.textContent = "临时草稿";

      const location = document.createElement("div");
      location.id = locationId;
      location.style.display = "none";
      location.style.flexWrap = "wrap";
      location.style.gap = "6px";
      location.style.fontSize = "11px";
      location.style.lineHeight = "16px";
      location.style.color = "#99F6E4";

      const draft = document.createElement("div");
      draft.id = draftId;
      draft.style.maxHeight = "30vh";
      draft.style.overflow = "hidden auto";
      draft.style.whiteSpace = "pre-wrap";
      draft.style.fontSize = "14px";
      draft.style.lineHeight = "21px";
      draft.style.color = "#E2E8F0";

      header.append(spinner, status);
      root.append(header, location, badge, draft);
      document.documentElement.append(root);
      return root;
    };

    const root = ensureRoot();
    const status = document.getElementById(statusId);
    const location = document.getElementById(locationId);
    const draft = document.getElementById(draftId);
    const badge = document.getElementById(badgeId);
    const spinner = document.getElementById(spinnerId);
    if (!status || !location || !draft || !badge || !spinner) return false;

    root.style.opacity = "1";
    root.style.transform = "translateY(0)";

    if (typeof input.label === "string") {
      status.textContent = input.label;
    }

    if (typeof input.locationSummary === "string" && input.locationSummary.length > 0) {
      location.textContent = input.locationSummary;
      location.style.display = "flex";
    } else if (input.mode === "begin") {
      location.textContent = "";
      location.style.display = "none";
    }

    if (typeof input.draftText === "string") {
      draft.textContent = input.draftText;
    }

    if (input.mode === "final" || input.mode === "complete") {
      spinner.style.animation = "none";
      spinner.style.borderColor = "rgba(34, 197, 94, 0.24)";
      spinner.style.borderTopColor = "rgba(34, 197, 94, 0.24)";
      spinner.style.background = "#22C55E";
      spinner.style.boxShadow = "0 0 0 3px rgba(34, 197, 94, 0.14)";
      badge.textContent = "最终回复";
      badge.style.background = "rgba(34, 197, 94, 0.16)";
      badge.style.color = "#BBF7D0";
      root.style.borderColor = "rgba(74, 222, 128, 0.34)";
    } else if (input.mode === "fail") {
      spinner.style.animation = "none";
      spinner.style.borderColor = "rgba(245, 158, 11, 0.28)";
      spinner.style.borderTopColor = "rgba(245, 158, 11, 0.28)";
      spinner.style.background = "#F59E0B";
      spinner.style.boxShadow = "0 0 0 3px rgba(245, 158, 11, 0.14)";
      badge.textContent = "生成失败";
      badge.style.background = "rgba(245, 158, 11, 0.18)";
      badge.style.color = "#FDE68A";
      root.style.borderColor = "rgba(251, 191, 36, 0.4)";
    } else {
      spinner.style.width = "14px";
      spinner.style.height = "14px";
      spinner.style.animation = "rollAgentReplyPreviewSpin 820ms linear infinite";
      spinner.style.border = "2px solid rgba(153, 246, 228, 0.24)";
      spinner.style.borderTopColor = "#99F6E4";
      spinner.style.background = "transparent";
      spinner.style.boxShadow = "none";
      badge.textContent = input.provisional === false ? "最终回复" : "临时草稿";
      badge.style.background = "rgba(20, 184, 166, 0.18)";
      badge.style.color = "#99F6E4";
      root.style.borderColor = "rgba(45, 212, 191, 0.32)";
    }

    return true;
  })()`;
}

export class NativeReplyPreviewVisualSession {
  private readonly target: NativePreviewTarget;

  constructor(target: NativePreviewTarget) {
    this.target = target;
  }

  async begin(label: string, locationSummary?: string): Promise<boolean> {
    return await this.render({
      mode: "begin",
      label,
      ...(locationSummary !== undefined && locationSummary.length > 0 ? { locationSummary } : {}),
      draftText: "",
      provisional: true,
    });
  }

  async updateStatus(label: string): Promise<boolean> {
    return await this.render({ mode: "status", label });
  }

  async updateDraft(draftText: string, provisional: boolean): Promise<boolean> {
    return await this.render({
      mode: provisional ? "draft" : "final",
      draftText,
      provisional,
    });
  }

  async complete(label: string, finalReply: string): Promise<boolean> {
    return await this.render({
      mode: "complete",
      label,
      draftText: finalReply,
      provisional: false,
    });
  }

  async fail(label: string): Promise<boolean> {
    return await this.render({ mode: "fail", label });
  }

  async clear(): Promise<boolean> {
    return await this.render({ mode: "clear" });
  }

  private async render(input: Parameters<typeof buildPreviewScript>[0]): Promise<boolean> {
    if (!isVisualActivityEnabled()) {
      return false;
    }

    try {
      return await this.target.evaluateJson<boolean>(buildPreviewScript(input));
    } catch {
      return false;
    }
  }
}
