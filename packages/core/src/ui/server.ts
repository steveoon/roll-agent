import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  CONFIG_ACTIVATION_KINDS,
  ConfigApplicationValidationError,
  type ConfigActivationEffect,
  type ConfigActivationKind,
} from "../config/application-service.ts";
import {
  ConfigRevisionConflictError,
  ConfigWriteLockError,
  type ConfigPath,
  type ConfigRevision,
} from "../config/document-store.ts";
import type {
  RollUiApplyEffectsRequest,
  RollUiConfigRequest,
  RollUiController,
  RollUiSaveConfigRequest,
  RollUiStaticAsset,
  RollUiStaticAssetProvider,
} from "./contracts.ts";
import { RollUiActivationInProgressError } from "./runtime-controller.ts";

export const ROLL_UI_HOST = "127.0.0.1" as const;
export const ROLL_UI_SESSION_COOKIE = "roll_ui_session" as const;
export const ROLL_UI_DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const MAX_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const TOKEN_BYTES = 32;
const ROUTE_TOKEN_BYTES = 24;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'none'",
].join("; ");

interface SessionState {
  readonly id: string;
  readonly csrfToken: string;
}

interface RequestRuntime {
  readonly origin: string;
  readonly expectedHost: string;
  readonly basePath: string;
  readonly sessionCookieName: string;
  readonly bodyLimitBytes: number;
  bootstrapToken: string | null;
  session: SessionState | null;
}

export interface StartRollUiServerOptions {
  readonly controller: RollUiController;
  readonly staticAssets: RollUiStaticAssetProvider;
  readonly signal?: AbortSignal;
  readonly onError?: (error: unknown) => void;
  readonly bodyLimitBytes?: number;
}

export interface RollUiServerHandle {
  readonly host: typeof ROLL_UI_HOST;
  readonly port: number;
  readonly origin: string;
  readonly basePath: string;
  /** Contains a one-time token in the URL fragment. Fragments are never sent in HTTP requests. */
  readonly url: string;
  close(): Promise<void>;
}

class RollUiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RollUiHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export async function startRollUiServer(
  options: StartRollUiServerOptions,
): Promise<RollUiServerHandle> {
  if (options.signal?.aborted === true) {
    throw new DOMException("The Roll UI server start was aborted.", "AbortError");
  }

  const bodyLimitBytes = normalizeBoundedInteger(
    options.bodyLimitBytes,
    ROLL_UI_DEFAULT_BODY_LIMIT_BYTES,
    MAX_BODY_LIMIT_BYTES,
    "bodyLimitBytes",
  );
  const bootstrapToken = createToken();
  const routeToken = randomBytes(ROUTE_TOKEN_BYTES).toString("base64url");
  const basePath = `/__roll_ui/${routeToken}`;
  let runtime: RequestRuntime | null = null;

  const server = createServer((request, response) => {
    if (runtime === null) {
      applySecurityHeaders(response);
      sendError(response, 503, "server_starting", "Roll UI is still starting.");
      return;
    }
    handleRequest(request, response, runtime, options).catch((error: unknown) => {
      discardRequestBody(request);
      handleRequestError(response, error, options.onError);
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  const port = await listenOnEphemeralLoopbackPort(server, (boundPort) => {
    const origin = `http://${ROLL_UI_HOST}:${boundPort}`;
    runtime = {
      origin,
      expectedHost: `${ROLL_UI_HOST}:${boundPort}`,
      basePath,
      sessionCookieName: `${ROLL_UI_SESSION_COOKIE}_${routeToken}`,
      bodyLimitBytes,
      bootstrapToken,
      session: null,
    };
  });
  const origin = `http://${ROLL_UI_HOST}:${port}`;

  let closePromise: Promise<void> | null = null;
  let abortListener: (() => void) | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    if (abortListener !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener("abort", abortListener);
    }
    closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    return closePromise;
  };

  if (options.signal !== undefined) {
    abortListener = () => {
      close().catch((error: unknown) => options.onError?.(error));
    };
    options.signal.addEventListener("abort", abortListener, { once: true });
    if (options.signal.aborted) abortListener();
  }

  return {
    host: ROLL_UI_HOST,
    port,
    origin,
    basePath,
    url: `${origin}${basePath}/#token=${encodeURIComponent(bootstrapToken)}`,
    close,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RequestRuntime,
  options: StartRollUiServerOptions,
): Promise<void> {
  applySecurityHeaders(response);
  enforceHost(request.headers, runtime.expectedHost);
  const url = parseRequestUrl(request.url, runtime.origin);
  const pathname = stripBasePath(url.pathname, runtime.basePath);

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    await handleApiRequest(request, response, pathname, runtime, options.controller);
    return;
  }
  await handleStaticRequest(request, response, pathname, options.staticAssets);
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  runtime: RequestRuntime,
  controller: RollUiController,
): Promise<void> {
  const method = request.method ?? "";
  enforceApiProvenance(request.headers, runtime.origin, method !== "GET");

  if (pathname === "/api/bootstrap") {
    if (method === "GET") {
      const session = requireSession(request.headers, runtime);
      sendData(response, publicSession(session));
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(request, runtime.bodyLimitBytes);
      const token = parseBootstrapRequest(body);
      if (runtime.bootstrapToken === null || !safeTokenEquals(token, runtime.bootstrapToken)) {
        throw new RollUiHttpError(401, "invalid_bootstrap_token", "Invalid bootstrap token.");
      }
      runtime.bootstrapToken = null;
      const session = createSession();
      runtime.session = session;
      response.setHeader(
        "Set-Cookie",
        createSessionCookie(session, runtime.sessionCookieName, runtime.basePath),
      );
      sendData(response, publicSession(session));
      return;
    }
    throw methodNotAllowed("GET, POST");
  }

  const session = requireSession(request.headers, runtime);
  if (pathname === "/api/config" && method === "GET") {
    sendData(response, await controller.getConfig());
    return;
  }
  if (pathname === "/api/catalog" && method === "GET") {
    sendData(response, await controller.getCatalog());
    return;
  }
  if (pathname === "/api/agents/status" && method === "GET") {
    sendData(response, await controller.getAgentStatus());
    return;
  }
  if (pathname === "/api/config/preview" && method === "POST") {
    requireCsrf(request.headers, session);
    const configRequest = parseConfigRequest(
      await readJsonBody(request, runtime.bodyLimitBytes),
      false,
    );
    sendData(response, await controller.previewConfig(configRequest));
    return;
  }
  if (pathname === "/api/config/save" && method === "POST") {
    requireCsrf(request.headers, session);
    const configRequest = parseConfigRequest(
      await readJsonBody(request, runtime.bodyLimitBytes),
      true,
    );
    sendData(response, await controller.saveConfig(configRequest));
    return;
  }
  if (pathname === "/api/agents/apply" && method === "POST") {
    requireCsrf(request.headers, session);
    const applyRequest = parseApplyEffectsRequest(
      await readJsonBody(request, runtime.bodyLimitBytes),
    );
    sendData(response, await controller.applyAgentEffects(applyRequest));
    return;
  }

  if (isKnownApiPath(pathname)) throw methodNotAllowed(allowedMethods(pathname));
  throw new RollUiHttpError(404, "not_found", "Not found.");
}

async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  staticAssets: RollUiStaticAssetProvider,
): Promise<void> {
  const method = request.method ?? "";
  if (method !== "GET" && method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  const normalizedPath = normalizeStaticPath(pathname);
  const asset = await staticAssets.getAsset(normalizedPath);
  if (asset === null) throw new RollUiHttpError(404, "not_found", "Not found.");
  sendAsset(response, asset, method === "HEAD");
}

function parseBootstrapRequest(value: unknown): string {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length > 256) {
    throw new RollUiHttpError(400, "invalid_request", "Expected a bootstrap token.");
  }
  return value.token;
}

function parseConfigRequest(value: unknown, revisionRequired: true): RollUiSaveConfigRequest;
function parseConfigRequest(value: unknown, revisionRequired: false): RollUiConfigRequest;
function parseConfigRequest(value: unknown, revisionRequired: boolean): RollUiConfigRequest {
  if (!isRecord(value)) {
    throw new RollUiHttpError(400, "invalid_request", "Expected a JSON object.");
  }
  const expectedRevision = parseOptionalRevision(value.expectedRevision);
  if (revisionRequired && expectedRevision === undefined) {
    throw new RollUiHttpError(
      400,
      "config_revision_required",
      "Saving requires the latest config revision.",
    );
  }
  if (value.mode === "structured") {
    if (!isRecord(value.persisted)) {
      throw new RollUiHttpError(
        400,
        "invalid_request",
        "Structured mode requires a persisted object.",
      );
    }
    return {
      mode: "structured",
      persisted: value.persisted,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    };
  }
  if (value.mode === "yaml") {
    if (typeof value.yaml !== "string") {
      throw new RollUiHttpError(400, "invalid_request", "YAML mode requires yaml text.");
    }
    return {
      mode: "yaml",
      yaml: value.yaml,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    };
  }
  throw new RollUiHttpError(400, "invalid_request", "Config mode must be structured or yaml.");
}

function parseApplyEffectsRequest(value: unknown): RollUiApplyEffectsRequest {
  if (!isRecord(value) || !Array.isArray(value.effects)) {
    throw new RollUiHttpError(400, "invalid_request", "Expected an effects array.");
  }
  return { effects: value.effects.map(parseActivationEffect) };
}

function parseActivationEffect(value: unknown): ConfigActivationEffect {
  if (!isRecord(value) || !isActivationKind(value.kind)) {
    throw new RollUiHttpError(400, "invalid_request", "Invalid activation effect kind.");
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) {
    throw new RollUiHttpError(400, "invalid_request", "Activation effect paths are required.");
  }
  const paths = value.paths.map(parseConfigPath);
  const title = parseBoundedText(value.title, "effect title", 500);
  const description = parseBoundedText(value.description, "effect description", 2_000);
  if (typeof value.requiresConfirmation !== "boolean") {
    throw new RollUiHttpError(400, "invalid_request", "Effect confirmation flag must be boolean.");
  }
  const agentName =
    value.agentName === undefined
      ? undefined
      : parseBoundedText(value.agentName, "agent name", 200);
  if (value.kind === "restart-agent" && agentName === undefined) {
    throw new RollUiHttpError(400, "invalid_request", "Restart effects require an agent name.");
  }
  return {
    kind: value.kind,
    paths,
    title,
    description,
    ...(agentName !== undefined ? { agentName } : {}),
    requiresConfirmation: value.requiresConfirmation,
  };
}

function parseConfigPath(value: unknown): ConfigPath {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new RollUiHttpError(400, "invalid_request", "Invalid config path.");
  }
  return value.map((segment) => {
    if (typeof segment === "string" && segment.length > 0 && segment.length <= 256) {
      return segment;
    }
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return segment;
    }
    throw new RollUiHttpError(400, "invalid_request", "Invalid config path segment.");
  });
}

function parseOptionalRevision(value: unknown): ConfigRevision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RollUiHttpError(400, "invalid_request", "Invalid config revision.");
  }
  return value as ConfigRevision;
}

function parseBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new RollUiHttpError(400, "invalid_request", `Invalid ${label}.`);
  }
  return value;
}

function isActivationKind(value: unknown): value is ConfigActivationKind {
  return CONFIG_ACTIVATION_KINDS.some((kind) => kind === value);
}

async function readJsonBody(request: IncomingMessage, bodyLimitBytes: number): Promise<unknown> {
  const contentType = singleHeader(request.headers["content-type"]);
  if (
    contentType === undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw new RollUiHttpError(415, "unsupported_media_type", "Expected application/json.");
  }
  const contentEncoding = singleHeader(request.headers["content-encoding"]);
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    throw new RollUiHttpError(
      415,
      "unsupported_content_encoding",
      "Compressed request bodies are not accepted.",
    );
  }
  const declaredLength = singleHeader(request.headers["content-length"]);
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RollUiHttpError(400, "invalid_content_length", "Invalid Content-Length.");
    }
    if (length > bodyLimitBytes) throw bodyTooLarge();
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > bodyLimitBytes) {
      request.resume();
      throw bodyTooLarge();
    }
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new RollUiHttpError(400, "invalid_json", "Malformed JSON body.", error);
  }
  assertJsonComplexity(value);
  return value;
}

function assertJsonComplexity(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new RollUiHttpError(400, "json_too_complex", "JSON body is too complex.");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function requireSession(headers: IncomingHttpHeaders, runtime: RequestRuntime): SessionState {
  const session = runtime.session;
  if (session === null) {
    throw new RollUiHttpError(401, "authentication_required", "Authentication required.");
  }
  const cookieValue = readCookie(headers.cookie, runtime.sessionCookieName);
  if (cookieValue === undefined || !safeTokenEquals(cookieValue, session.id)) {
    throw new RollUiHttpError(401, "authentication_required", "Authentication required.");
  }
  return session;
}

function requireCsrf(headers: IncomingHttpHeaders, session: SessionState): void {
  const token = singleHeader(headers["x-csrf-token"]);
  if (token === undefined || !safeTokenEquals(token, session.csrfToken)) {
    throw new RollUiHttpError(403, "invalid_csrf_token", "Invalid CSRF token.");
  }
}

function enforceHost(headers: IncomingHttpHeaders, expectedHost: string): void {
  if (headers.host !== expectedHost) {
    throw new RollUiHttpError(421, "invalid_host", "Invalid Host header.");
  }
}

function enforceApiProvenance(
  headers: IncomingHttpHeaders,
  expectedOrigin: string,
  originRequired: boolean,
): void {
  const origin = singleHeader(headers.origin);
  if (
    (originRequired && origin !== expectedOrigin) ||
    (origin !== undefined && origin !== expectedOrigin)
  ) {
    throw new RollUiHttpError(403, "invalid_origin", "Invalid Origin header.");
  }
  const fetchSite = singleHeader(headers["sec-fetch-site"]);
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    throw new RollUiHttpError(403, "invalid_request_site", "Cross-site requests are not accepted.");
  }
}

function parseRequestUrl(requestUrl: string | undefined, origin: string): URL {
  if (requestUrl === undefined || !requestUrl.startsWith("/")) {
    throw new RollUiHttpError(400, "invalid_request_target", "Invalid request target.");
  }
  const url = new URL(requestUrl, origin);
  if (url.origin !== origin) {
    throw new RollUiHttpError(400, "invalid_request_target", "Invalid request target.");
  }
  return url;
}

function stripBasePath(pathname: string, basePath: string): string {
  const prefix = `${basePath}/`;
  if (!pathname.startsWith(prefix)) {
    throw new RollUiHttpError(404, "not_found", "Not found.");
  }
  return `/${pathname.slice(prefix.length)}`;
}

function normalizeStaticPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    throw new RollUiHttpError(400, "invalid_path", "Invalid URL path.", error);
  }
  if (decoded === "/") return "/index.html";
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) {
    throw new RollUiHttpError(400, "invalid_path", "Invalid URL path.");
  }
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RollUiHttpError(400, "invalid_path", "Invalid URL path.");
  }
  return `/${segments.join("/")}`;
}

function createSession(): SessionState {
  return {
    id: createToken(),
    csrfToken: createToken(),
  };
}

function publicSession(session: SessionState) {
  return {
    csrfToken: session.csrfToken,
  } as const;
}

function createSessionCookie(session: SessionState, cookieName: string, basePath: string): string {
  return `${cookieName}=${session.id}; Path=${basePath}/; HttpOnly; SameSite=Strict`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const values = header
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`))
    .map((entry) => entry.slice(name.length + 1));
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
}

function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-DNS-Prefetch-Control", "off");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendData(response: ServerResponse, data: unknown): void {
  sendJson(response, 200, { data });
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  sendJson(response, statusCode, {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
}

function sendAsset(response: ServerResponse, asset: RollUiStaticAsset, head: boolean): void {
  const body = typeof asset.body === "string" ? Buffer.from(asset.body) : Buffer.from(asset.body);
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.contentType);
  response.setHeader("Content-Length", body.byteLength);
  response.end(head ? undefined : body);
}

function handleRequestError(
  response: ServerResponse,
  error: unknown,
  onError: ((error: unknown) => void) | undefined,
): void {
  if (response.headersSent) {
    response.destroy();
    onError?.(error);
    return;
  }
  if (error instanceof RollUiHttpError) {
    if (error.code === "method_not_allowed" && typeof error.details === "string") {
      response.setHeader("Allow", error.details);
    }
    sendError(response, error.statusCode, error.code, error.message);
    return;
  }
  if (error instanceof ConfigApplicationValidationError) {
    sendError(response, 422, error.code, error.message, { issues: error.issues });
    return;
  }
  if (error instanceof ConfigRevisionConflictError) {
    sendError(response, 409, error.code, error.message, {
      actualRevision: error.actualRevision,
      expectedRevision: error.expectedRevision,
    });
    return;
  }
  if (error instanceof ConfigWriteLockError || error instanceof RollUiActivationInProgressError) {
    sendError(response, 409, error.code, error.message);
    return;
  }
  onError?.(error);
  sendError(response, 500, "internal_error", "Internal server error.");
}

function discardRequestBody(request: IncomingMessage): void {
  if (!request.complete && !request.destroyed) request.resume();
}

function methodNotAllowed(allow: string): RollUiHttpError {
  return new RollUiHttpError(405, "method_not_allowed", "Method not allowed.", allow);
}

function bodyTooLarge(): RollUiHttpError {
  return new RollUiHttpError(413, "body_too_large", "Request body is too large.");
}

function isKnownApiPath(pathname: string): boolean {
  return [
    "/api/config",
    "/api/catalog",
    "/api/agents/status",
    "/api/config/preview",
    "/api/config/save",
    "/api/agents/apply",
  ].includes(pathname);
}

function allowedMethods(pathname: string): string {
  return pathname === "/api/config" ||
    pathname === "/api/catalog" ||
    pathname === "/api/agents/status"
    ? "GET"
    : "POST";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listenOnEphemeralLoopbackPort(
  server: ReturnType<typeof createServer>,
  onListening: (port: number) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const handleError = (error: Error): void => {
      reject(error);
    };
    server.once("error", handleError);
    server.listen({ host: ROLL_UI_HOST, port: 0, exclusive: true }, () => {
      server.off("error", handleError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Roll UI server did not receive an IPv4 address."));
        return;
      }
      const port = (address as AddressInfo).port;
      onListening(port);
      resolve(port);
    });
  });
}
