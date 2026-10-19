// Keep diagnostic fields useful without recording headers, bodies, or credentials.
export function diagnosticText(value) {
  return String(value)
    .replace(/\b(?:authorization|set-cookie|cookie)\b["']?\s*[:=][^\r\n]*/giu, "[redacted header]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:access_token|refresh_token|id_token|api[_-]?key|client_secret|password|token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/giu,
      "[redacted credential]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .slice(0, 1000);
}

export function diagnosticError(error, depth = 0) {
  if (depth >= 5) return { message: "[cause depth limit]" };
  if (error === null || typeof error !== "object") return { message: diagnosticText(error) };
  return {
    name: diagnosticText(error.name ?? "Error"),
    message: diagnosticText(error.message ?? "No error message"),
    ...(error.code === undefined ? {} : { code: diagnosticText(error.code) }),
    ...(typeof error.statusCode === "number" ? { statusCode: error.statusCode } : {}),
    ...(error.cause === undefined ? {} : { cause: diagnosticError(error.cause, depth + 1) }),
  };
}
