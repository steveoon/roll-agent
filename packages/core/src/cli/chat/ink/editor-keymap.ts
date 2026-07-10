import type { Key } from "ink";
import type { LineBufferState } from "./line-buffer.ts";
import {
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  killToLineEnd,
  killToLineStart,
  moveDown,
  moveLeft,
  moveRight,
  moveToLineEnd,
  moveToLineStart,
  moveUp,
  moveWordLeft,
  moveWordRight,
} from "./line-buffer.ts";

const EDITOR_KEY_BINDINGS = {
  leftArrow: "move-left",
  rightArrow: "move-right",
  "ctrl+leftArrow": "move-word-left",
  "meta+leftArrow": "move-word-left",
  "meta+b": "move-word-left",
  "ctrl+rightArrow": "move-word-right",
  "meta+rightArrow": "move-word-right",
  "meta+f": "move-word-right",
  home: "move-line-start",
  "ctrl+a": "move-line-start",
  end: "move-line-end",
  "ctrl+e": "move-line-end",
  upArrow: "move-up",
  downArrow: "move-down",
  backspace: "delete-backward",
  delete: "delete-forward",
  "ctrl+w": "delete-word-backward",
  "meta+backspace": "delete-word-backward",
  "ctrl+backspace": "delete-word-backward",
  "ctrl+u": "kill-line-start",
  "ctrl+k": "kill-line-end",
} as const;

export type EditorCommand = (typeof EDITOR_KEY_BINDINGS)[keyof typeof EDITOR_KEY_BINDINGS];

const NAMED_KEYS = [
  "leftArrow",
  "rightArrow",
  "upArrow",
  "downArrow",
  "home",
  "end",
  "backspace",
  "delete",
] as const;

function describeKey(input: string, key: Key): string | undefined {
  const named = NAMED_KEYS.find((name) => key[name]);
  const base = named ?? (input.length === 1 ? input.toLowerCase() : undefined);
  if (base === undefined) {
    return undefined;
  }
  return `${key.ctrl ? "ctrl+" : ""}${key.meta ? "meta+" : ""}${base}`;
}

function isEditorBinding(descriptor: string): descriptor is keyof typeof EDITOR_KEY_BINDINGS {
  return descriptor in EDITOR_KEY_BINDINGS;
}

export function resolveEditorCommand(input: string, key: Key): EditorCommand | undefined {
  const descriptor = describeKey(input, key);
  if (descriptor === undefined || !isEditorBinding(descriptor)) {
    return undefined;
  }
  return EDITOR_KEY_BINDINGS[descriptor];
}

const EDITOR_COMMAND_HANDLERS: Record<EditorCommand, (state: LineBufferState) => LineBufferState> =
  {
    "move-left": moveLeft,
    "move-right": moveRight,
    "move-word-left": moveWordLeft,
    "move-word-right": moveWordRight,
    "move-line-start": moveToLineStart,
    "move-line-end": moveToLineEnd,
    "move-up": moveUp,
    "move-down": moveDown,
    "delete-backward": deleteBackward,
    "delete-forward": deleteForward,
    "delete-word-backward": deleteWordBackward,
    "kill-line-start": killToLineStart,
    "kill-line-end": killToLineEnd,
  };

export function applyEditorCommand(
  command: EditorCommand,
  state: LineBufferState,
): LineBufferState {
  return EDITOR_COMMAND_HANDLERS[command](state);
}
