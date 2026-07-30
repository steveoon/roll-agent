import type { RollRendererApi } from "./preload.ts";

declare global {
  interface Window {
    readonly roll: RollRendererApi;
  }
}

const output = document.querySelector<HTMLPreElement>("#output");
const form = document.querySelector<HTMLFormElement>("#chat-form");
const input = document.querySelector<HTMLInputElement>("#message");
const approvalDialog = document.querySelector<HTMLDialogElement>("#approval-dialog");
const approvalTitle = document.querySelector<HTMLElement>("#approval-title");
const approvalReason = document.querySelector<HTMLElement>("#approval-reason");
const approvalPreview = document.querySelector<HTMLElement>("#approval-preview");
let threadId: string | undefined;

function requireApprovalDialog(): {
  readonly dialog: HTMLDialogElement;
  readonly title: HTMLElement;
  readonly reason: HTMLElement;
  readonly preview: HTMLElement;
} {
  if (
    approvalDialog === null ||
    approvalTitle === null ||
    approvalReason === null ||
    approvalPreview === null
  ) {
    throw new Error("Approval dialog is missing required elements");
  }
  return {
    dialog: approvalDialog,
    title: approvalTitle,
    reason: approvalReason,
    preview: approvalPreview,
  };
}

window.roll.onApprovalRequest(({ approval }, { signal }) => {
  const { dialog, title, reason, preview } = requireApprovalDialog();
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Approval request was cancelled"),
    );
  }
  if (dialog.open) {
    return Promise.reject(new Error("Another approval dialog is already open"));
  }
  title.textContent = `${approval.agentName}.${approval.toolName}`;
  reason.textContent = approval.reason ?? "This tool requires your approval.";
  preview.textContent = JSON.stringify(approval.preview, null, 2);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onCancel = (event: Event) => {
      event.preventDefault();
      dialog.close("reject");
    };
    const onClose = () => {
      cleanup();
      resolve(
        dialog.returnValue === "approve"
          ? { decision: "approve" }
          : { decision: "reject", reason: "用户取消" },
      );
    };
    const onAbort = () => {
      cleanup();
      if (dialog.open) {
        dialog.close();
      }
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Approval request was cancelled"),
      );
    };

    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    dialog.showModal();
  });
});

window.roll.onEvent((event) => {
  if (output !== null) {
    output.textContent += `${JSON.stringify(event)}\n`;
  }
});

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  Promise.resolve()
    .then(async () => {
      if (input === null || input.value.trim().length === 0) {
        return;
      }
      if (threadId === undefined) {
        const created = await window.roll.createThread({
          requestId: crypto.randomUUID(),
          title: "Electron reference",
        });
        threadId = created.thread.id;
      }
      await window.roll.startTurn({
        requestId: crypto.randomUUID(),
        threadId,
        turnId: crypto.randomUUID(),
        input: { text: input.value },
      });
      input.value = "";
    })
    .catch((error: unknown) => {
      if (output !== null) {
        output.textContent += `ERROR: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    });
});
