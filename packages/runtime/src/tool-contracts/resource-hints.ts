export const ROLL_RESOURCE_HINTS_META_KEY = "roll/resourceHints";

export const TOOL_RESOURCE_ACCESS_MODES = {
  read: "read",
  write: "write",
} as const;

export const OPAQUE_SIDE_EFFECT_RESOURCE = "shell:opaque-side-effects";

export type ToolResourceAccessMode =
  (typeof TOOL_RESOURCE_ACCESS_MODES)[keyof typeof TOOL_RESOURCE_ACCESS_MODES];

export interface ToolResourceAccess {
  readonly key: string;
  readonly mode: ToolResourceAccessMode;
}

export const TOOL_RESOURCE_HINT_KINDS = {
  file: "file",
  browserSession: "browser-session",
  conversation: "conversation",
  custom: "custom",
} as const;

export type ToolResourceHintKind =
  (typeof TOOL_RESOURCE_HINT_KINDS)[keyof typeof TOOL_RESOURCE_HINT_KINDS];

export interface ToolResourceHint {
  /** Top-level tool input field containing one resource id or an array of ids. */
  readonly field: string;
  readonly kind: ToolResourceHintKind;
  readonly mode?: ToolResourceAccessMode;
  /** Required for `custom`; ignored for built-in kinds. */
  readonly namespace?: string;
}
