import type { RollRendererApi } from "./preload.ts";

declare global {
  interface Window {
    readonly roll: RollRendererApi;
  }
}

const output = document.querySelector<HTMLPreElement>("#output");
const form = document.querySelector<HTMLFormElement>("#chat-form");
const input = document.querySelector<HTMLInputElement>("#message");
let threadId: string | undefined;

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
