import type { RollRendererApi } from "./preload.ts";
import {
  APPROVAL_EXPLANATION_PREVIEW_KEY,
  USER_INPUT_CONTROL_TYPES,
  USER_INPUT_TEXT_MAX_CHARS,
  getApprovalExplanation,
  normalizeUserInputResult,
  userInputBooleanControlSchema,
  userInputChoiceControlSchema,
  userInputMultilineControlSchema,
  userInputNumberControlSchema,
  userInputTextControlSchema,
  type UserInputBooleanControl,
  type UserInputChoiceControl,
  type UserInputControl,
  type UserInputMultilineControl,
  type UserInputNumberControl,
  type UserInputSubmittedValue,
  type UserInputTextControl,
} from "@roll-agent/protocol";

declare global {
  interface Window {
    readonly roll: RollRendererApi;
  }
}

interface UserInputField {
  readonly container: HTMLElement;
  read(): UserInputSubmittedValue | undefined;
  focus(): void;
}

interface UserInputElements {
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly title: HTMLElement;
  readonly description: HTMLElement;
  readonly controls: HTMLElement;
  readonly error: HTMLElement;
  readonly cancel: HTMLButtonElement;
}

const output = document.querySelector<HTMLPreElement>("#output");
const form = document.querySelector<HTMLFormElement>("#chat-form");
const input = document.querySelector<HTMLInputElement>("#message");
const approvalDialog = document.querySelector<HTMLDialogElement>("#approval-dialog");
const approvalTitle = document.querySelector<HTMLElement>("#approval-title");
const approvalReason = document.querySelector<HTMLElement>("#approval-reason");
const approvalExplanation = document.querySelector<HTMLElement>("#approval-explanation");
const approvalPreview = document.querySelector<HTMLElement>("#approval-preview");
const userInputDialog = document.querySelector<HTMLDialogElement>("#user-input-dialog");
const userInputForm = document.querySelector<HTMLFormElement>("#user-input-form");
const userInputTitle = document.querySelector<HTMLElement>("#user-input-title");
const userInputDescription = document.querySelector<HTMLElement>("#user-input-description");
const userInputControls = document.querySelector<HTMLElement>("#user-input-controls");
const userInputError = document.querySelector<HTMLElement>("#user-input-error");
const userInputCancel = document.querySelector<HTMLButtonElement>("#user-input-cancel");
let threadId: string | undefined;

function requireApprovalDialog(): {
  readonly dialog: HTMLDialogElement;
  readonly title: HTMLElement;
  readonly reason: HTMLElement;
  readonly explanation: HTMLElement;
  readonly preview: HTMLElement;
} {
  if (
    approvalDialog === null ||
    approvalTitle === null ||
    approvalReason === null ||
    approvalExplanation === null ||
    approvalPreview === null
  ) {
    throw new Error("Approval dialog is missing required elements");
  }
  return {
    dialog: approvalDialog,
    title: approvalTitle,
    reason: approvalReason,
    explanation: approvalExplanation,
    preview: approvalPreview,
  };
}

function requireUserInputElements(): UserInputElements {
  if (
    userInputDialog === null ||
    userInputForm === null ||
    userInputTitle === null ||
    userInputDescription === null ||
    userInputControls === null ||
    userInputError === null ||
    userInputCancel === null
  ) {
    throw new Error("User Input dialog is missing required elements");
  }
  return {
    dialog: userInputDialog,
    form: userInputForm,
    title: userInputTitle,
    description: userInputDescription,
    controls: userInputControls,
    error: userInputError,
    cancel: userInputCancel,
  };
}

function getInteractionAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Runtime cancelled the interaction");
}

function isInteractionDialogOpen(): boolean {
  return approvalDialog?.open === true || userInputDialog?.open === true;
}

function appendDescription(container: HTMLElement, description: string | undefined): void {
  if (description === undefined) {
    return;
  }
  const element = document.createElement("p");
  element.className = "user-input-control-description";
  element.textContent = description;
  container.append(element);
}

function createFieldLabel(
  control: Pick<UserInputControl, "label" | "required">,
  htmlFor: string,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.htmlFor = htmlFor;
  label.textContent = control.required ? `${control.label} *` : control.label;
  return label;
}

function shouldOmitEmptyText(
  control: UserInputTextControl | UserInputMultilineControl,
  value: string,
): boolean {
  return value.length === 0 && !control.required;
}

function createTextField(control: UserInputTextControl, controlIndex: number): UserInputField {
  const container = document.createElement("div");
  container.className = "user-input-control";
  const element = document.createElement("input");
  element.id = `user-input-control-${String(controlIndex)}`;
  element.type = "text";
  element.autocomplete = "off";
  element.maxLength = control.maxLength ?? USER_INPUT_TEXT_MAX_CHARS;
  element.minLength = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
  container.append(createFieldLabel(control, element.id), element);
  appendDescription(container, control.description);
  return {
    container,
    read: () =>
      shouldOmitEmptyText(control, element.value)
        ? undefined
        : { id: control.id, value: element.value },
    focus: () => element.focus(),
  };
}

function createMultilineField(
  control: UserInputMultilineControl,
  controlIndex: number,
): UserInputField {
  const container = document.createElement("div");
  container.className = "user-input-control";
  const element = document.createElement("textarea");
  element.id = `user-input-control-${String(controlIndex)}`;
  element.rows = 4;
  element.maxLength = control.maxLength ?? USER_INPUT_TEXT_MAX_CHARS;
  element.minLength = Math.max(control.minLength ?? 0, control.required ? 1 : 0);
  container.append(createFieldLabel(control, element.id), element);
  appendDescription(container, control.description);
  return {
    container,
    read: () =>
      shouldOmitEmptyText(control, element.value)
        ? undefined
        : { id: control.id, value: element.value },
    focus: () => element.focus(),
  };
}

function createNumberField(control: UserInputNumberControl, controlIndex: number): UserInputField {
  const container = document.createElement("div");
  container.className = "user-input-control";
  const element = document.createElement("input");
  element.id = `user-input-control-${String(controlIndex)}`;
  element.type = "number";
  element.step = control.integer === true ? "1" : "any";
  if (control.min !== undefined) {
    element.min = String(control.min);
  }
  if (control.max !== undefined) {
    element.max = String(control.max);
  }
  container.append(createFieldLabel(control, element.id), element);
  appendDescription(container, control.description);
  return {
    container,
    read: () =>
      element.value.length === 0 ? undefined : { id: control.id, value: Number(element.value) },
    focus: () => element.focus(),
  };
}

function createBooleanField(
  control: UserInputBooleanControl,
  controlIndex: number,
): UserInputField {
  const container = document.createElement("div");
  container.className = "user-input-control";
  const label = document.createElement("label");
  label.className = "user-input-checkbox";
  const element = document.createElement("input");
  element.id = `user-input-control-${String(controlIndex)}`;
  element.type = "checkbox";
  const labelText = document.createElement("span");
  labelText.textContent = control.required ? `${control.label} *` : control.label;
  label.append(element, labelText);
  container.append(label);
  appendDescription(container, control.description);
  return {
    container,
    read: () => ({ id: control.id, value: element.checked }),
    focus: () => element.focus(),
  };
}

function createChoiceField(control: UserInputChoiceControl, controlIndex: number): UserInputField {
  const container = document.createElement("fieldset");
  container.className = "user-input-control user-input-choice";
  const legend = document.createElement("legend");
  legend.textContent = control.required ? `${control.label} *` : control.label;
  container.append(legend);
  appendDescription(container, control.description);
  const optionInputs: { readonly optionId: string; readonly input: HTMLInputElement }[] = [];
  for (const [optionIndex, option] of control.options.entries()) {
    const optionContainer = document.createElement("div");
    optionContainer.className = "user-input-choice-option";
    const label = document.createElement("label");
    const optionInput = document.createElement("input");
    optionInput.id = `user-input-control-${String(controlIndex)}-option-${String(optionIndex)}`;
    optionInput.name = `user-input-control-${String(controlIndex)}`;
    optionInput.type = control.multiple ? "checkbox" : "radio";
    optionInput.value = option.id;
    const labelText = document.createElement("span");
    labelText.textContent = option.label;
    label.append(optionInput, labelText);
    optionContainer.append(label);
    appendDescription(optionContainer, option.description);
    container.append(optionContainer);
    optionInputs.push({ optionId: option.id, input: optionInput });
  }
  return {
    container,
    read: () => {
      const selected = optionInputs.filter(({ input }) => input.checked);
      if (control.multiple) {
        return { id: control.id, value: selected.map(({ optionId }) => optionId) };
      }
      const selectedOption = selected[0];
      return selectedOption === undefined
        ? undefined
        : { id: control.id, value: selectedOption.optionId };
    },
    focus: () => optionInputs[0]?.input.focus(),
  };
}

type UserInputFieldFactory = (control: UserInputControl, controlIndex: number) => UserInputField;

const USER_INPUT_FIELD_FACTORIES = {
  [USER_INPUT_CONTROL_TYPES.text]: ((control, controlIndex) =>
    createTextField(
      userInputTextControlSchema.parse(control),
      controlIndex,
    )) satisfies UserInputFieldFactory,
  [USER_INPUT_CONTROL_TYPES.multiline]: ((control, controlIndex) =>
    createMultilineField(
      userInputMultilineControlSchema.parse(control),
      controlIndex,
    )) satisfies UserInputFieldFactory,
  [USER_INPUT_CONTROL_TYPES.number]: ((control, controlIndex) =>
    createNumberField(
      userInputNumberControlSchema.parse(control),
      controlIndex,
    )) satisfies UserInputFieldFactory,
  [USER_INPUT_CONTROL_TYPES.boolean]: ((control, controlIndex) =>
    createBooleanField(
      userInputBooleanControlSchema.parse(control),
      controlIndex,
    )) satisfies UserInputFieldFactory,
  [USER_INPUT_CONTROL_TYPES.choice]: ((control, controlIndex) =>
    createChoiceField(
      userInputChoiceControlSchema.parse(control),
      controlIndex,
    )) satisfies UserInputFieldFactory,
} as const satisfies Readonly<Record<UserInputControl["type"], UserInputFieldFactory>>;

function createUserInputField(control: UserInputControl, controlIndex: number): UserInputField {
  return USER_INPUT_FIELD_FACTORIES[control.type](control, controlIndex);
}

window.roll.onApprovalRequest(({ approval }, { signal }) => {
  const { dialog, title, reason, explanation, preview } = requireApprovalDialog();
  if (signal.aborted) {
    return Promise.reject(getInteractionAbortError(signal));
  }
  if (isInteractionDialogOpen()) {
    return Promise.reject(new Error("Another interaction dialog is already open"));
  }
  title.textContent = `${approval.agentName}.${approval.toolName}`;
  reason.textContent = approval.reason ?? "This tool requires your approval.";
  const explanationText = getApprovalExplanation(approval);
  explanation.textContent =
    explanationText === undefined ? "" : `AI explanation: ${explanationText}`;
  explanation.hidden = explanationText === undefined;
  if (
    typeof approval.preview === "object" &&
    approval.preview !== null &&
    !Array.isArray(approval.preview)
  ) {
    const { [APPROVAL_EXPLANATION_PREVIEW_KEY]: _explanation, ...commandPreview } =
      approval.preview;
    preview.textContent = JSON.stringify(commandPreview, null, 2);
  } else {
    preview.textContent = JSON.stringify(approval.preview, null, 2);
  }

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
      reject(getInteractionAbortError(signal));
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

window.roll.onUserInputRequest((params, { signal }) => {
  const elements = requireUserInputElements();
  if (signal.aborted) {
    return Promise.reject(getInteractionAbortError(signal));
  }
  if (isInteractionDialogOpen()) {
    return Promise.reject(new Error("Another interaction dialog is already open"));
  }

  elements.form.reset();
  elements.controls.replaceChildren();
  elements.title.textContent = params.title ?? "Input required";
  elements.description.textContent = params.description ?? "";
  elements.description.hidden = params.description === undefined;
  elements.error.textContent = "";
  elements.error.hidden = true;
  const fields = params.controls.map((control, index) => createUserInputField(control, index));
  elements.controls.append(...fields.map(({ container }) => container));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      elements.dialog.removeEventListener("cancel", onDialogCancel);
      elements.cancel.removeEventListener("click", onCancelClick);
      elements.form.removeEventListener("submit", onSubmit);
      signal.removeEventListener("abort", onAbort);
    };
    const close = () => {
      if (elements.dialog.open) {
        elements.dialog.close();
      }
    };
    const clearValues = () => {
      elements.form.reset();
      elements.controls.replaceChildren();
    };
    const finishCancelled = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      close();
      clearValues();
      resolve({ status: "cancelled", reason: "用户取消" });
    };
    const onDialogCancel = (event: Event) => {
      event.preventDefault();
      finishCancelled();
    };
    const onCancelClick = () => finishCancelled();
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      const values: UserInputSubmittedValue[] = [];
      for (const field of fields) {
        const value = field.read();
        if (value !== undefined) {
          values.push(value);
        }
      }
      try {
        const result = normalizeUserInputResult(params, { status: "submitted", values });
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        close();
        clearValues();
        resolve(result);
      } catch {
        elements.error.textContent = "Please check required fields, formats, and selection limits.";
        elements.error.hidden = false;
        fields[0]?.focus();
      }
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      close();
      clearValues();
      reject(getInteractionAbortError(signal));
    };

    elements.dialog.addEventListener("cancel", onDialogCancel);
    elements.cancel.addEventListener("click", onCancelClick);
    elements.form.addEventListener("submit", onSubmit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      elements.dialog.showModal();
      fields[0]?.focus();
    } catch (error: unknown) {
      settled = true;
      cleanup();
      clearValues();
      reject(error instanceof Error ? error : new Error("Could not open User Input dialog"));
    }
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
