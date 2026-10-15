import { requestDigest } from "./request-budget.ts";

/** Opaque transport changes invalidate calibration, but are not semantic maintenance progress. */
function maintenanceValue(value: unknown, metadata = false, contentPart = false): unknown {
  if (value instanceof Uint8Array || value instanceof URL) return "[opaque payload]";
  if (Array.isArray(value)) {
    return value.map((item) => maintenanceValue(item, metadata, contentPart));
  }
  if (typeof value !== "object" || value === null) return value;
  if (
    contentPart &&
    "type" in value &&
    typeof value.type === "string" &&
    /^(?:image|file|audio)(?:-|$)/u.test(value.type)
  ) {
    // Keep the presence/type of multimodal content, not its bytes, URL or provider ID.
    return { type: value.type };
  }
  const entries = Object.entries(value).flatMap<readonly [string, unknown]>(([key, item]) => {
    // Business tool arguments and results are semantic data, even when they use
    // names such as type=image or providerMetadata. Only transport wrappers vary.
    if (key === "input" || key === "args" || key === "output") return [[key, item] as const];
    if (key === "providerMetadata" || (metadata && /signature|encrypted|file_?id/iu.test(key))) {
      return [];
    }
    const normalized = maintenanceValue(
      item,
      metadata || key === "providerOptions" || key === "options",
      key === "content",
    );
    return normalized === undefined ? [] : [[key, normalized] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function maintenanceDigest(value: unknown): string {
  return requestDigest(maintenanceValue(value));
}
