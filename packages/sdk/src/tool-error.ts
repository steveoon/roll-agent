export type StructuredToolErrorPayload = {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export class StructuredToolError extends Error {
  readonly payload: StructuredToolErrorPayload;

  constructor(payload: StructuredToolErrorPayload) {
    super(payload.message);
    this.name = "StructuredToolError";
    this.payload = payload;
  }
}

export function isStructuredToolError(
  value: unknown,
): value is Error & { readonly payload: StructuredToolErrorPayload } {
  if (value instanceof StructuredToolError) {
    return true;
  }

  if (!(value instanceof Error) || !("payload" in value)) {
    return false;
  }

  return isStructuredToolErrorPayload(value.payload);
}

function isStructuredToolErrorPayload(value: unknown): value is StructuredToolErrorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const details = payload["details"];
  return (
    typeof payload["code"] === "string" &&
    typeof payload["message"] === "string" &&
    (details === undefined ||
      (typeof details === "object" && details !== null && !Array.isArray(details)))
  );
}
