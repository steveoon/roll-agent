export class ChatGptAuthError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  constructor(
    code: string,
    message: string,
    status?: number,
    requestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChatGptAuthError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function isTemporaryChatGptError(error: unknown): boolean {
  return (
    error instanceof ChatGptAuthError &&
    (error.code === "network_error" ||
      error.code === "jwks_unavailable" ||
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500))
  );
}
