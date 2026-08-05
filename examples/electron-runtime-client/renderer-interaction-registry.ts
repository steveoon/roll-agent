import { randomUUID } from "node:crypto";

export const RENDERER_INTERACTION_METHODS = ["approval.request", "userInput.request"] as const;

export type RendererInteractionMethod = (typeof RENDERER_INTERACTION_METHODS)[number];

export interface RendererInteractionAuthority {
  readonly method: RendererInteractionMethod;
  readonly webContentsId: number;
  readonly documentGeneration: number;
}

export interface RegisteredRendererInteraction {
  readonly requestToken: string;
  readonly promise: Promise<unknown>;
}

interface PendingRendererInteraction extends RendererInteractionAuthority {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type RequestTokenFactory = () => string;

function assertAuthorityMatches(
  pending: PendingRendererInteraction,
  authority: RendererInteractionAuthority,
): void {
  if (
    pending.method !== authority.method ||
    pending.webContentsId !== authority.webContentsId ||
    pending.documentGeneration !== authority.documentGeneration
  ) {
    throw new Error("Renderer interaction is not pending for this method, window, and document");
  }
}

export class RendererInteractionRegistry {
  readonly #pending = new Map<string, PendingRendererInteraction>();
  readonly #createRequestToken: RequestTokenFactory;
  #nextRequestSequence = 1;

  constructor(createRequestToken: RequestTokenFactory = randomUUID) {
    this.#createRequestToken = createRequestToken;
  }

  register(authority: RendererInteractionAuthority): RegisteredRendererInteraction {
    if (!Number.isInteger(authority.webContentsId) || authority.webContentsId < 0) {
      throw new Error("webContentsId must be a non-negative integer");
    }
    if (!Number.isSafeInteger(authority.documentGeneration) || authority.documentGeneration < 0) {
      throw new Error("documentGeneration must be a non-negative safe integer");
    }

    const requestToken = this.#allocateRequestToken();
    const deferred = Promise.withResolvers<unknown>();
    this.#pending.set(requestToken, {
      ...authority,
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    return { requestToken, promise: deferred.promise };
  }

  resolve(requestToken: string, authority: RendererInteractionAuthority, value: unknown): void {
    const pending = this.#requirePending(requestToken);
    assertAuthorityMatches(pending, authority);
    this.#pending.delete(requestToken);
    pending.resolve(value);
  }

  reject(requestToken: string, authority: RendererInteractionAuthority, error: Error): void {
    const pending = this.#requirePending(requestToken);
    assertAuthorityMatches(pending, authority);
    this.#pending.delete(requestToken);
    pending.reject(error);
  }

  cancel(requestToken: string, authority: RendererInteractionAuthority, error: Error): boolean {
    const pending = this.#pending.get(requestToken);
    if (pending === undefined) {
      return false;
    }
    assertAuthorityMatches(pending, authority);
    this.#pending.delete(requestToken);
    pending.reject(error);
    return true;
  }

  invalidateDocument(webContentsId: number, documentGeneration: number, error: Error): number {
    return this.#invalidateMatching(
      (pending) =>
        pending.webContentsId === webContentsId &&
        pending.documentGeneration === documentGeneration,
      error,
    );
  }

  invalidateWebContents(webContentsId: number, error: Error): number {
    return this.#invalidateMatching((pending) => pending.webContentsId === webContentsId, error);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #allocateRequestToken(): string {
    if (!Number.isSafeInteger(this.#nextRequestSequence)) {
      throw new Error("Renderer interaction request token sequence is exhausted");
    }
    const entropy = this.#createRequestToken();
    if (entropy.length === 0) {
      throw new Error("Renderer interaction request token entropy must not be empty");
    }
    const requestToken = `${String(this.#nextRequestSequence)}:${entropy}`;
    this.#nextRequestSequence += 1;
    return requestToken;
  }

  #requirePending(requestToken: string): PendingRendererInteraction {
    const pending = this.#pending.get(requestToken);
    if (pending === undefined) {
      throw new Error("Renderer interaction is no longer pending");
    }
    return pending;
  }

  #invalidateMatching(
    matches: (pending: PendingRendererInteraction) => boolean,
    error: Error,
  ): number {
    const invalidated: PendingRendererInteraction[] = [];
    for (const [requestToken, pending] of this.#pending) {
      if (matches(pending)) {
        this.#pending.delete(requestToken);
        invalidated.push(pending);
      }
    }
    for (const pending of invalidated) {
      pending.reject(error);
    }
    return invalidated.length;
  }
}
