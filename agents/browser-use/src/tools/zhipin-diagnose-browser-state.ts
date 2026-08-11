import { defineTool } from "@roll-agent/sdk";
import type {
  Browser,
  BrowserContextManager,
  BrowserInspectablePage,
  BrowserPageInfo,
  BrowserRuntime,
  NativeCdpController,
  Page,
} from "@roll-agent/browser";
import { BrowserPageInfoSchema } from "@roll-agent/browser";
import { z } from "zod";
import { getContextManager, getRuntime } from "../runtime-holder.ts";
import { matchesPlatformHost } from "../platforms.ts";
import { openZhipinNativePagePort } from "../pages/zhipin/native-page.ts";
import { toAttachedPageInfo, toNativePageInfo } from "../page-info.ts";

const ZHIPIN_DIAGNOSTIC_PHASES = [
  "native",
  "native-watch",
  "native-ws-connect",
  "native-page-bring-front",
  "native-evaluate-url-no-runtime-enable",
  "native-dom-read-no-runtime-enable",
  "native-input-move-no-runtime-enable",
  "native-runtime-enable",
  "native-evaluate-url",
  "native-dom-read",
  "resume-canvas",
  "browser-attach",
  "page-attach",
  "network-watch",
  "page-evaluate",
  "detector-fingerprint",
  "storage-summary",
] as const;

const NATIVE_TARGET_SNAPSHOT_PHASES = [
  ...ZHIPIN_DIAGNOSTIC_PHASES,
  "native-ws-connect-watch",
  "native-page-bring-front-watch",
  "native-evaluate-url-no-runtime-enable-watch",
  "native-dom-read-no-runtime-enable-watch",
  "native-input-move-no-runtime-enable-watch",
  "native-runtime-enable-watch",
  "native-evaluate-url-watch",
  "native-dom-read-watch",
  "browser-attach-watch",
] as const;

const StorageAreaSchema = z.enum(["localStorage", "sessionStorage"]);
const JsonKindSchema = z.enum(["array", "object", "string", "number", "boolean", "null"]);
const StorageValueKindSchema = z.enum(["empty", "json", "string"]);
const ZhipinDiagnosticPhaseSchema = z.enum(ZHIPIN_DIAGNOSTIC_PHASES);
const NativeTargetSnapshotPhaseSchema = z.enum(NATIVE_TARGET_SNAPSHOT_PHASES);
const NetworkEventKindSchema = z.enum(["request", "response"]);
const NetworkEventReasonSchema = z.enum([
  "apm-action-log",
  "device-action-report",
  "boss-risk-report",
  "zhipin-security",
]);

const StorageEntrySummarySchema = z.object({
  area: StorageAreaSchema,
  key: z.string(),
  valueLength: z.number().int().nonnegative(),
  valueKind: StorageValueKindSchema,
  jsonKind: JsonKindSchema.optional(),
  jsonTopLevelKeys: z.array(z.string()).optional(),
  jsonArrayLength: z.number().int().nonnegative().optional(),
  numericFields: z.record(z.number()).optional(),
  booleanFields: z.record(z.boolean()).optional(),
  arrayLengths: z.record(z.number().int().nonnegative()).optional(),
});

const CookieSummarySchema = z.object({
  name: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.string(),
  valueLength: z.number().int().nonnegative(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.string().optional(),
});

const NumericFieldDeltaSchema = z.object({
  before: z.number().optional(),
  after: z.number().optional(),
  delta: z.number().optional(),
});

const BooleanFieldChangeSchema = z.object({
  before: z.boolean().optional(),
  after: z.boolean().optional(),
});

const ArrayLengthDeltaSchema = z.object({
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
  delta: z.number().int().optional(),
});

const StorageCounterDiffSchema = z.object({
  area: StorageAreaSchema,
  key: z.string(),
  beforePresent: z.boolean(),
  afterPresent: z.boolean(),
  numericDeltas: z.record(NumericFieldDeltaSchema).optional(),
  booleanChanges: z.record(BooleanFieldChangeSchema).optional(),
  arrayLengthDeltas: z.record(ArrayLengthDeltaSchema).optional(),
});

const PageEvaluateSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  visibilityState: z.string(),
  hasFocus: z.boolean(),
});

const DetectorFingerprintSummarySchema = z.object({
  navigatorWebdriver: z.boolean().optional(),
  userAgentContainsHeadless: z.boolean(),
  languagesLength: z.number().int().nonnegative(),
  pluginsLength: z.number().int().nonnegative(),
  hasChromeRuntime: z.boolean(),
  permissionQueryIsNative: z.boolean().optional(),
  hasPlaywrightBinding: z.boolean(),
  hasPwInitScripts: z.boolean(),
  cdcKeys: z.array(z.string()),
  webdriverKeys: z.array(z.string()),
  automationLikeWindowKeys: z.array(z.string()),
});

const NativeCdpDomSummarySchema = z.object({
  rootNodeId: z.number().int(),
  rootNodeName: z.string(),
  childNodeCount: z.number().int().nonnegative().optional(),
  bodyTextLength: z.number().int().nonnegative().optional(),
  elementCount: z.number().int().nonnegative().optional(),
});

const NativeCdpInputSummarySchema = z.object({
  type: z.literal("mouseMoved"),
  x: z.number(),
  y: z.number(),
});

const NativeCdpProbeSummarySchema = z.object({
  targetId: z.string(),
  websocketUrlAvailable: z.boolean(),
  connected: z.boolean(),
  pageBroughtToFront: z.boolean().optional(),
  runtimeEnabled: z.boolean().optional(),
  evaluate: PageEvaluateSummarySchema.optional(),
  dom: NativeCdpDomSummarySchema.optional(),
  input: NativeCdpInputSummarySchema.optional(),
});

const DiagnosticPhaseResultSchema = z.object({
  phase: ZhipinDiagnosticPhaseSchema,
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});

const NativeTargetSnapshotSchema = z.object({
  phase: NativeTargetSnapshotPhaseSchema,
  capturedAt: z.string(),
  targetFound: z.boolean(),
  page: BrowserPageInfoSchema.optional(),
  urlChangedFromPrevious: z.boolean(),
  titleChangedFromPrevious: z.boolean(),
  previousUrl: z.string().optional(),
  currentUrl: z.string().optional(),
  previousTitle: z.string().optional(),
  currentTitle: z.string().optional(),
});

const NetworkEventSummarySchema = z.object({
  kind: NetworkEventKindSchema,
  reason: NetworkEventReasonSchema,
  capturedAt: z.string(),
  url: z.string(),
  method: z.string().optional(),
  resourceType: z.string().optional(),
  status: z.number().int().optional(),
});

const NavigationEventSummarySchema = z.object({
  capturedAt: z.string(),
  url: z.string(),
});

const ZhipinDiagnoseBrowserStateInputSchema = z.object({
  phase: ZhipinDiagnosticPhaseSchema.default("native").describe(
    "诊断阶段。默认 native 只枚举原生 CDP target；native-* 阶段使用原生 CDP page WebSocket；resume-canvas 只读探测简历弹窗与 canvas 就绪状态和坐标；browser-attach 及更深阶段才会使用 Playwright attach。",
  ),
  targetPageId: z
    .string()
    .optional()
    .describe("可选：通过 list_pages 或本工具 native 阶段看到的 BOSS 页面 pageId/targetId。"),
  watchMs: z
    .number()
    .int()
    .min(500)
    .max(10_000)
    .default(3_000)
    .describe(
      "native-watch / browser-attach 后置观察 / network-watch / storage-summary 内部等待窗口，单位毫秒。",
    ),
  networkEventLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(30)
    .describe("network-watch 最多返回的相关 request/response 事件数。"),
});

const ZhipinDiagnoseBrowserStateOutputSchema = z.object({
  success: z.boolean(),
  requestedPhase: ZhipinDiagnosticPhaseSchema,
  mode: z.string(),
  nativePages: z.array(BrowserPageInfoSchema),
  targetPage: BrowserPageInfoSchema.optional(),
  browserAttached: z.boolean(),
  pageAttached: z.boolean(),
  nativeTimeline: z.array(NativeTargetSnapshotSchema),
  networkEvents: z.array(NetworkEventSummarySchema).optional(),
  navigationEvents: z.array(NavigationEventSummarySchema).optional(),
  nativeCdp: NativeCdpProbeSummarySchema.optional(),
  resumeCanvas: z
    .object({
      dialogVisible: z.boolean(),
      iframeFound: z.boolean(),
      iframeVisible: z.boolean(),
      canvasReady: z.boolean(),
      screenshotArea: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      canvasSize: z.object({ width: z.number(), height: z.number() }).optional(),
      error: z.string().optional(),
    })
    .optional(),
  evaluate: PageEvaluateSummarySchema.optional(),
  detectorFingerprint: DetectorFingerprintSummarySchema.optional(),
  storage: z
    .object({
      localStorage: z.array(StorageEntrySummarySchema),
      sessionStorage: z.array(StorageEntrySummarySchema),
      cookies: z.array(CookieSummarySchema),
      counterDiffs: z.array(StorageCounterDiffSchema),
    })
    .optional(),
  phases: z.array(DiagnosticPhaseResultSchema),
  warnings: z.array(z.string()),
});

type StorageArea = z.infer<typeof StorageAreaSchema>;
type ZhipinDiagnosticPhase = z.infer<typeof ZhipinDiagnosticPhaseSchema>;
type StorageEntrySummary = z.infer<typeof StorageEntrySummarySchema>;
type CookieSummary = z.infer<typeof CookieSummarySchema>;
type PageEvaluateSummary = z.infer<typeof PageEvaluateSummarySchema>;
type NativeCdpDomSummary = z.infer<typeof NativeCdpDomSummarySchema>;
type NativeCdpInputSummary = z.infer<typeof NativeCdpInputSummarySchema>;
type NativeCdpProbeSummary = z.infer<typeof NativeCdpProbeSummarySchema>;
type DiagnosticPhaseResult = z.infer<typeof DiagnosticPhaseResultSchema>;
type NativeTargetSnapshotPhase = z.infer<typeof NativeTargetSnapshotPhaseSchema>;
type NativeTargetSnapshot = z.infer<typeof NativeTargetSnapshotSchema>;
type NetworkEventReason = z.infer<typeof NetworkEventReasonSchema>;
type NetworkEventSummary = z.infer<typeof NetworkEventSummarySchema>;
type NavigationEventSummary = z.infer<typeof NavigationEventSummarySchema>;
type DetectorFingerprintSummary = z.infer<typeof DetectorFingerprintSummarySchema>;
type NumericFieldDelta = z.infer<typeof NumericFieldDeltaSchema>;
type BooleanFieldChange = z.infer<typeof BooleanFieldChangeSchema>;
type ArrayLengthDelta = z.infer<typeof ArrayLengthDeltaSchema>;
type StorageCounterDiff = z.infer<typeof StorageCounterDiffSchema>;

type RawStorageEntry = {
  readonly key: string;
  readonly value: string;
};

type RequestLike = {
  url(): string;
  method(): string;
  resourceType(): string;
};

type ResponseLike = {
  url(): string;
  status(): number;
  request(): RequestLike;
};

type FrameLike = {
  url(): string;
};

type NetworkWatchResult = {
  readonly networkEvents: NetworkEventSummary[];
  readonly navigationEvents: NavigationEventSummary[];
};

type NativeCdpProbeResult = {
  readonly summary: NativeCdpProbeSummary;
  readonly triggeredNavigation: boolean;
};

const SECURITY_COUNTER_STORAGE_KEYS = ["_AEG_CNT", "_ZP_CNT_", "__local__sec__store___"] as const;
const SECURITY_COUNTER_STORAGE_KEY_SET = new Set<string>(SECURITY_COUNTER_STORAGE_KEYS);
const NATIVE_CDP_DIAGNOSTIC_PHASES = [
  "native-ws-connect",
  "native-page-bring-front",
  "native-evaluate-url-no-runtime-enable",
  "native-dom-read-no-runtime-enable",
  "native-input-move-no-runtime-enable",
  "native-runtime-enable",
  "native-evaluate-url",
  "native-dom-read",
] as const satisfies ReadonlyArray<ZhipinDiagnosticPhase>;
type NativeCdpDiagnosticPhase = (typeof NATIVE_CDP_DIAGNOSTIC_PHASES)[number];

const NATIVE_CDP_NO_RUNTIME_PHASES = [
  "native-page-bring-front",
  "native-evaluate-url-no-runtime-enable",
  "native-dom-read-no-runtime-enable",
  "native-input-move-no-runtime-enable",
] as const satisfies ReadonlyArray<NativeCdpDiagnosticPhase>;
type NativeCdpNoRuntimePhase = (typeof NATIVE_CDP_NO_RUNTIME_PHASES)[number];

const NATIVE_CDP_WATCH_PHASE_BY_PHASE = {
  "native-ws-connect": "native-ws-connect-watch",
  "native-page-bring-front": "native-page-bring-front-watch",
  "native-evaluate-url-no-runtime-enable": "native-evaluate-url-no-runtime-enable-watch",
  "native-dom-read-no-runtime-enable": "native-dom-read-no-runtime-enable-watch",
  "native-input-move-no-runtime-enable": "native-input-move-no-runtime-enable-watch",
  "native-runtime-enable": "native-runtime-enable-watch",
  "native-evaluate-url": "native-evaluate-url-watch",
  "native-dom-read": "native-dom-read-watch",
} as const satisfies Record<NativeCdpDiagnosticPhase, NativeTargetSnapshotPhase>;

function getJsonKind(value: unknown): z.infer<typeof JsonKindSchema> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      return "string";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeCdpDiagnosticPhase(
  phase: ZhipinDiagnosticPhase,
): phase is NativeCdpDiagnosticPhase {
  return NATIVE_CDP_DIAGNOSTIC_PHASES.includes(phase as NativeCdpDiagnosticPhase);
}

function isNativeCdpNoRuntimePhase(
  phase: NativeCdpDiagnosticPhase,
): phase is NativeCdpNoRuntimePhase {
  return NATIVE_CDP_NO_RUNTIME_PHASES.includes(phase as NativeCdpNoRuntimePhase);
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function summarizeJsonRecordFields(
  value: Record<string, unknown>,
): Pick<StorageEntrySummary, "numericFields" | "booleanFields" | "arrayLengths"> {
  const numericFields = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  const booleanFields = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
  const arrayLengths = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([key, item]) => [key, item.length] as const),
  );

  return {
    ...(Object.keys(numericFields).length > 0 ? { numericFields } : {}),
    ...(Object.keys(booleanFields).length > 0 ? { booleanFields } : {}),
    ...(Object.keys(arrayLengths).length > 0 ? { arrayLengths } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSecurityCounterStorageKey(key: string): boolean {
  return SECURITY_COUNTER_STORAGE_KEY_SET.has(key);
}

export function summarizeStorageEntry(
  area: StorageArea,
  entry: RawStorageEntry,
): StorageEntrySummary {
  if (entry.value.length === 0) {
    return {
      area,
      key: entry.key,
      valueLength: 0,
      valueKind: "empty",
    };
  }

  const parsed = parseJsonValue(entry.value);
  if (parsed === undefined) {
    return {
      area,
      key: entry.key,
      valueLength: entry.value.length,
      valueKind: "string",
    };
  }

  const jsonKind = getJsonKind(parsed);
  const objectSummary =
    isRecord(parsed) && isSecurityCounterStorageKey(entry.key)
      ? summarizeJsonRecordFields(parsed)
      : {};

  return {
    area,
    key: entry.key,
    valueLength: entry.value.length,
    valueKind: "json",
    jsonKind,
    ...(isRecord(parsed) ? { jsonTopLevelKeys: Object.keys(parsed) } : {}),
    ...(Array.isArray(parsed) ? { jsonArrayLength: parsed.length } : {}),
    ...objectSummary,
  };
}

export function summarizeCookie(cookie: {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: string;
}): CookieSummary {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : "Session",
    valueLength: cookie.value.length,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
  };
}

async function measurePhase<T>(
  phase: ZhipinDiagnosticPhase,
  action: () => Promise<T>,
): Promise<{ readonly result?: T; readonly phaseResult: DiagnosticPhaseResult }> {
  const startedAt = Date.now();
  try {
    const result = await action();
    return {
      result,
      phaseResult: {
        phase,
        success: true,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      phaseResult: {
        phase,
        success: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function resolveNativeZhipinTarget(
  nativePages: ReadonlyArray<BrowserInspectablePage>,
  targetPageId: string | undefined,
  warnings: string[],
): BrowserInspectablePage | undefined {
  if (targetPageId !== undefined) {
    const target = nativePages.find((page) => page.targetId === targetPageId);
    if (!target) {
      warnings.push(`targetPageId "${targetPageId}" not found in native pages.`);
      return undefined;
    }
    if (!matchesPlatformHost(target.url, "zhipin")) {
      warnings.push(`targetPageId "${targetPageId}" is not a zhipin page.`);
      return undefined;
    }
    return target;
  }

  const zhipinPages = nativePages.filter((page) => matchesPlatformHost(page.url, "zhipin"));
  if (zhipinPages.length === 1) {
    return zhipinPages[0];
  }
  if (zhipinPages.length === 0) {
    warnings.push("No zhipin native page found. Open Boss first or pass targetPageId.");
  } else {
    warnings.push("Multiple zhipin native pages found. Pass targetPageId to avoid ambiguity.");
  }
  return undefined;
}

function createNativeTargetSnapshot(
  ctxManager: BrowserContextManager,
  phase: NativeTargetSnapshotPhase,
  page: BrowserInspectablePage | undefined,
  previous: NativeTargetSnapshot | undefined,
): NativeTargetSnapshot {
  const currentUrl = page?.url;
  const currentTitle = page?.title;
  const previousUrl = previous?.currentUrl;
  const previousTitle = previous?.currentTitle;

  return {
    phase,
    capturedAt: new Date().toISOString(),
    targetFound: page !== undefined,
    ...(page !== undefined ? { page: toNativePageInfo(ctxManager, page) } : {}),
    urlChangedFromPrevious:
      previousUrl !== undefined && currentUrl !== undefined && previousUrl !== currentUrl,
    titleChangedFromPrevious:
      previousTitle !== undefined && currentTitle !== undefined && previousTitle !== currentTitle,
    ...(previousUrl !== undefined ? { previousUrl } : {}),
    ...(currentUrl !== undefined ? { currentUrl } : {}),
    ...(previousTitle !== undefined ? { previousTitle } : {}),
    ...(currentTitle !== undefined ? { currentTitle } : {}),
  };
}

async function captureNativeTargetSnapshot(
  ctxManager: BrowserContextManager,
  phase: NativeTargetSnapshotPhase,
  targetPageId: string | undefined,
  previous: NativeTargetSnapshot | undefined,
): Promise<NativeTargetSnapshot> {
  const nativePages = await ctxManager.listNativePages();
  const target =
    targetPageId !== undefined
      ? nativePages.find((page) => page.targetId === targetPageId)
      : nativePages.filter((page) => matchesPlatformHost(page.url, "zhipin"))[0];

  return createNativeTargetSnapshot(ctxManager, phase, target, previous);
}

async function appendNativeSnapshot(
  ctxManager: BrowserContextManager,
  nativeTimeline: NativeTargetSnapshot[],
  phase: NativeTargetSnapshotPhase,
  targetPageId: string | undefined,
  warnings: string[],
): Promise<void> {
  try {
    const previous = nativeTimeline[nativeTimeline.length - 1];
    const snapshot = await captureNativeTargetSnapshot(ctxManager, phase, targetPageId, previous);
    nativeTimeline.push(snapshot);
    if (snapshot.urlChangedFromPrevious) {
      warnings.push(
        `Target URL changed after ${phase}: ${snapshot.previousUrl ?? "(unknown)"} -> ${
          snapshot.currentUrl ?? "(missing)"
        }.`,
      );
    }
  } catch (error) {
    warnings.push(
      `Failed to capture native snapshot after ${phase}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }
}

async function appendNativeWatchSnapshots(
  ctxManager: BrowserContextManager,
  nativeTimeline: NativeTargetSnapshot[],
  phase: NativeTargetSnapshotPhase,
  targetPageId: string | undefined,
  watchMs: number,
  warnings: string[],
): Promise<boolean> {
  const startedLength = nativeTimeline.length;
  const startedAt = Date.now();

  while (true) {
    await appendNativeSnapshot(ctxManager, nativeTimeline, phase, targetPageId, warnings);
    const remainingMs = watchMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(500, remainingMs));
  }

  return nativeTimeline
    .slice(startedLength)
    .some((snapshot) => snapshot.urlChangedFromPrevious);
}

function readPageEvaluateSummaryFromUnknown(value: unknown): PageEvaluateSummary {
  if (!isRecord(value)) {
    throw new Error("Native CDP evaluate did not return an object value.");
  }

  const url = value["url"];
  const title = value["title"];
  const visibilityState = value["visibilityState"];
  const hasFocus = value["hasFocus"];

  if (
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof visibilityState !== "string" ||
    typeof hasFocus !== "boolean"
  ) {
    throw new Error("Native CDP evaluate returned an unexpected page summary shape.");
  }

  return {
    url,
    title,
    visibilityState,
    hasFocus,
  };
}

function readNativeDomSummaryFromUnknown(
  documentPayload: unknown,
  metricsValue: unknown,
): NativeCdpDomSummary {
  if (!isRecord(documentPayload)) {
    throw new Error("Native CDP DOM.getDocument did not return an object.");
  }
  const root = documentPayload["root"];
  if (!isRecord(root)) {
    throw new Error("Native CDP DOM.getDocument did not return a root node.");
  }

  const rootNodeId = root["nodeId"];
  const rootNodeName = root["nodeName"];
  const childNodeCount = root["childNodeCount"];
  if (typeof rootNodeId !== "number" || typeof rootNodeName !== "string") {
    throw new Error("Native CDP DOM root node has an unexpected shape.");
  }

  const metrics = isRecord(metricsValue) ? metricsValue : {};
  const bodyTextLength = metrics["bodyTextLength"];
  const elementCount = metrics["elementCount"];

  return {
    rootNodeId,
    rootNodeName,
    ...(typeof childNodeCount === "number" ? { childNodeCount } : {}),
    ...(typeof bodyTextLength === "number" ? { bodyTextLength } : {}),
    ...(typeof elementCount === "number" ? { elementCount } : {}),
  };
}

async function readNativeCdpPageEvaluateSummary(
  client: NativeCdpController,
): Promise<PageEvaluateSummary> {
  const value = await client.evaluateJson(
    `(() => ({
      url: location.href,
      title: document.title,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus()
    }))()`,
  );
  return readPageEvaluateSummaryFromUnknown(value);
}

async function readNativeCdpDomSummary(
  client: NativeCdpController,
): Promise<NativeCdpDomSummary> {
  const documentPayload = await client.getDocument({
    depth: 1,
    pierce: false,
  });
  const metricsValue = await client.evaluateJson(
    `(() => ({
      bodyTextLength: document.body?.innerText?.length ?? 0,
      elementCount: document.querySelectorAll("*").length
    }))()`,
  );
  return readNativeDomSummaryFromUnknown(documentPayload, metricsValue);
}

async function readNativeCdpDomDocumentSummary(
  client: NativeCdpController,
): Promise<NativeCdpDomSummary> {
  const documentPayload = await client.getDocument({
    depth: 1,
    pierce: false,
  });
  return readNativeDomSummaryFromUnknown(documentPayload, undefined);
}

async function bringNativeCdpPageToFront(client: NativeCdpController): Promise<boolean> {
  await client.bringToFront();
  return true;
}

async function dispatchNativeCdpMouseMove(
  client: NativeCdpController,
): Promise<NativeCdpInputSummary> {
  const inputSummary = {
    type: "mouseMoved",
    x: 0,
    y: 0,
  } as const satisfies NativeCdpInputSummary;
  await client.dispatchMouseEvent({
    type: inputSummary.type,
    x: inputSummary.x,
    y: inputSummary.y,
  });
  return inputSummary;
}

async function observeAfterNativeCdpPhase(
  ctxManager: BrowserContextManager,
  nativeTimeline: NativeTargetSnapshot[],
  phase: NativeCdpDiagnosticPhase,
  targetPageId: string | undefined,
  watchMs: number,
  warnings: string[],
): Promise<boolean> {
  await appendNativeSnapshot(ctxManager, nativeTimeline, phase, targetPageId, warnings);
  const triggeredNavigation = await appendNativeWatchSnapshots(
    ctxManager,
    nativeTimeline,
    NATIVE_CDP_WATCH_PHASE_BY_PHASE[phase],
    targetPageId,
    watchMs,
    warnings,
  );
  if (triggeredNavigation) {
    warnings.push(
      `Native CDP phase ${phase} was followed by a native URL change; stop before deeper native CDP operations.`,
    );
  }
  return triggeredNavigation;
}

async function executeNativeCdpNoRuntimePhase(
  phase: NativeCdpNoRuntimePhase,
  client: NativeCdpController,
  phases: DiagnosticPhaseResult[],
  summary: NativeCdpProbeSummary,
): Promise<DiagnosticPhaseResult> {
  switch (phase) {
    case "native-page-bring-front": {
      const phaseRun = await measurePhase(
        phase,
        async () => await bringNativeCdpPageToFront(client),
      );
      phases.push(phaseRun.phaseResult);
      if (phaseRun.result !== undefined) {
        summary.pageBroughtToFront = phaseRun.result;
      }
      return phaseRun.phaseResult;
    }
    case "native-evaluate-url-no-runtime-enable": {
      const phaseRun = await measurePhase(
        phase,
        async () => await readNativeCdpPageEvaluateSummary(client),
      );
      phases.push(phaseRun.phaseResult);
      if (phaseRun.result !== undefined) {
        summary.evaluate = phaseRun.result;
      }
      return phaseRun.phaseResult;
    }
    case "native-dom-read-no-runtime-enable": {
      const phaseRun = await measurePhase(
        phase,
        async () => await readNativeCdpDomDocumentSummary(client),
      );
      phases.push(phaseRun.phaseResult);
      if (phaseRun.result !== undefined) {
        summary.dom = phaseRun.result;
      }
      return phaseRun.phaseResult;
    }
    case "native-input-move-no-runtime-enable": {
      const phaseRun = await measurePhase(
        phase,
        async () => await dispatchNativeCdpMouseMove(client),
      );
      phases.push(phaseRun.phaseResult);
      if (phaseRun.result !== undefined) {
        summary.input = phaseRun.result;
      }
      return phaseRun.phaseResult;
    }
  }
}

async function runNativeCdpProbe(params: {
  readonly requestedPhase: NativeCdpDiagnosticPhase;
  readonly target: BrowserInspectablePage;
  readonly runtime: BrowserRuntime;
  readonly ctxManager: BrowserContextManager;
  readonly targetPageId: string | undefined;
  readonly watchMs: number;
  readonly phases: DiagnosticPhaseResult[];
  readonly nativeTimeline: NativeTargetSnapshot[];
  readonly warnings: string[];
}): Promise<NativeCdpProbeResult> {
  const summary: NativeCdpProbeSummary = {
    targetId: params.target.targetId,
    websocketUrlAvailable:
      typeof params.target.webSocketDebuggerUrl === "string" &&
      params.target.webSocketDebuggerUrl.length > 0,
    connected: false,
  };
  const webSocketDebuggerUrl = params.target.webSocketDebuggerUrl;
  let client: NativeCdpController | undefined;

  try {
    const connectPhase = await measurePhase(
      "native-ws-connect",
      async () => {
        if (webSocketDebuggerUrl === undefined || webSocketDebuggerUrl.length === 0) {
          throw new Error("Native CDP target does not expose webSocketDebuggerUrl.");
        }
        return await params.runtime.connectNativePage(params.target, {
          allowUnsafeRuntimeEnableForDiagnostics: true,
        });
      },
    );
    params.phases.push(connectPhase.phaseResult);
    client = connectPhase.result;
    summary.connected = connectPhase.phaseResult.success;
    if (!connectPhase.phaseResult.success || client === undefined) {
      return { summary, triggeredNavigation: false };
    }
    const connectedClient = client;

    let triggeredNavigation = await observeAfterNativeCdpPhase(
      params.ctxManager,
      params.nativeTimeline,
      "native-ws-connect",
      params.targetPageId,
      params.watchMs,
      params.warnings,
    );
    if (params.requestedPhase === "native-ws-connect" || triggeredNavigation) {
      return { summary, triggeredNavigation };
    }

    if (isNativeCdpNoRuntimePhase(params.requestedPhase)) {
      await executeNativeCdpNoRuntimePhase(
        params.requestedPhase,
        connectedClient,
        params.phases,
        summary,
      );
      triggeredNavigation = await observeAfterNativeCdpPhase(
        params.ctxManager,
        params.nativeTimeline,
        params.requestedPhase,
        params.targetPageId,
        params.watchMs,
        params.warnings,
      );
      return {
        summary,
        triggeredNavigation,
      };
    }

    const runtimeEnablePhase = await measurePhase(
      "native-runtime-enable",
      async () => await connectedClient.unsafeEnableRuntimeForDiagnostics(),
    );
    params.phases.push(runtimeEnablePhase.phaseResult);
    summary.runtimeEnabled = runtimeEnablePhase.phaseResult.success;
    triggeredNavigation = await observeAfterNativeCdpPhase(
      params.ctxManager,
      params.nativeTimeline,
      "native-runtime-enable",
      params.targetPageId,
      params.watchMs,
      params.warnings,
    );
    if (
      !runtimeEnablePhase.phaseResult.success ||
      params.requestedPhase === "native-runtime-enable" ||
      triggeredNavigation
    ) {
      return { summary, triggeredNavigation };
    }

    const evaluatePhase = await measurePhase(
      "native-evaluate-url",
      async () => await readNativeCdpPageEvaluateSummary(connectedClient),
    );
    params.phases.push(evaluatePhase.phaseResult);
    if (evaluatePhase.result !== undefined) {
      summary.evaluate = evaluatePhase.result;
    }
    triggeredNavigation = await observeAfterNativeCdpPhase(
      params.ctxManager,
      params.nativeTimeline,
      "native-evaluate-url",
      params.targetPageId,
      params.watchMs,
      params.warnings,
    );
    if (
      !evaluatePhase.phaseResult.success ||
      params.requestedPhase === "native-evaluate-url" ||
      triggeredNavigation
    ) {
      return { summary, triggeredNavigation };
    }

    const domPhase = await measurePhase(
      "native-dom-read",
      async () => await readNativeCdpDomSummary(connectedClient),
    );
    params.phases.push(domPhase.phaseResult);
    if (domPhase.result !== undefined) {
      summary.dom = domPhase.result;
    }
    triggeredNavigation = await observeAfterNativeCdpPhase(
      params.ctxManager,
      params.nativeTimeline,
      "native-dom-read",
      params.targetPageId,
      params.watchMs,
      params.warnings,
    );
    if (!domPhase.phaseResult.success) {
      return { summary, triggeredNavigation };
    }
    return { summary, triggeredNavigation };
  } finally {
    client?.close();
  }
}

function classifyNetworkUrl(url: string): NetworkEventReason | undefined {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("device-action-report")) {
    return "device-action-report";
  }
  if (lowerUrl.includes("boss_risk_report")) {
    return "boss-risk-report";
  }
  if (lowerUrl.includes("apm-fe.zhipin.com") || lowerUrl.includes("/wapi/zpapm/actionlog/")) {
    return "apm-action-log";
  }
  if (lowerUrl.includes("zhipin-security") || lowerUrl.includes("/security/")) {
    return "zhipin-security";
  }
  return undefined;
}

async function watchRelevantNetworkEvents(
  page: Page,
  watchMs: number,
  eventLimit: number,
): Promise<NetworkWatchResult> {
  const networkEvents: NetworkEventSummary[] = [];
  const navigationEvents: NavigationEventSummary[] = [];

  const pushEvent = (event: NetworkEventSummary): void => {
    if (networkEvents.length < eventLimit) {
      networkEvents.push(event);
    }
  };

  const handleRequest = (request: RequestLike): void => {
    const url = request.url();
    const reason = classifyNetworkUrl(url);
    if (reason === undefined) {
      return;
    }

    pushEvent({
      kind: "request",
      reason,
      capturedAt: new Date().toISOString(),
      url,
      method: request.method(),
      resourceType: request.resourceType(),
    });
  };

  const handleResponse = (response: ResponseLike): void => {
    const url = response.url();
    const reason = classifyNetworkUrl(url);
    if (reason === undefined) {
      return;
    }
    const request = response.request();

    pushEvent({
      kind: "response",
      reason,
      capturedAt: new Date().toISOString(),
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
    });
  };

  const handleFrameNavigated = (frame: FrameLike): void => {
    navigationEvents.push({
      capturedAt: new Date().toISOString(),
      url: frame.url(),
    });
  };

  page.on("request", handleRequest);
  page.on("response", handleResponse);
  page.on("framenavigated", handleFrameNavigated);
  try {
    await delay(watchMs);
  } finally {
    page.off("request", handleRequest);
    page.off("response", handleResponse);
    page.off("framenavigated", handleFrameNavigated);
  }

  return { networkEvents, navigationEvents };
}

function findAttachedPageForNativeTarget(
  browser: Browser,
  target: BrowserInspectablePage,
): Page | undefined {
  const zhipinPages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => !page.isClosed() && matchesPlatformHost(page.url(), "zhipin"));

  return zhipinPages.find((page) => page.url() === target.url) ?? zhipinPages[0];
}

function mergeNetworkWatchResults(
  results: ReadonlyArray<NetworkWatchResult>,
  eventLimit: number,
): NetworkWatchResult {
  return {
    networkEvents: results.flatMap((result) => result.networkEvents).slice(0, eventLimit),
    navigationEvents: results.flatMap((result) => result.navigationEvents),
  };
}

async function readStorageEntries(
  page: Page,
  area: StorageArea,
): Promise<ReadonlyArray<RawStorageEntry>> {
  return await page.evaluate((selectedArea) => {
    const storage = selectedArea === "localStorage" ? window.localStorage : window.sessionStorage;
    return Array.from({ length: storage.length }, (_item, index) => {
      const key = storage.key(index) ?? "";
      return {
        key,
        value: key.length > 0 ? (storage.getItem(key) ?? "") : "",
      };
    }).filter((entry) => entry.key.length > 0);
  }, area);
}

async function readSecurityCounterEntries(page: Page): Promise<ReadonlyArray<StorageEntrySummary>> {
  const entries = await page.evaluate((keys) => {
    const areas = ["localStorage", "sessionStorage"] as const;
    const result: Array<{ area: (typeof areas)[number]; key: string; value: string }> = [];

    for (const area of areas) {
      const storage = area === "localStorage" ? window.localStorage : window.sessionStorage;
      for (const key of keys) {
        const value = storage.getItem(key);
        if (value !== null) {
          result.push({
            area,
            key,
            value,
          });
        }
      }
    }

    return result;
  }, SECURITY_COUNTER_STORAGE_KEYS);

  return entries.map((entry) =>
    summarizeStorageEntry(entry.area, {
      key: entry.key,
      value: entry.value,
    }),
  );
}

async function readPageEvaluateSummary(page: Page): Promise<PageEvaluateSummary> {
  return await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  }));
}

async function readDetectorFingerprintSummary(page: Page): Promise<DetectorFingerprintSummary> {
  return await page.evaluate(() => {
    const windowRecord = window as typeof window & Record<string, unknown>;
    const windowKeys = Object.keys(windowRecord);
    const cdcKeys = windowKeys
      .filter((key) => key.startsWith("cdc_") || key.includes("_cdc_"))
      .slice(0, 20);
    const webdriverKeys = windowKeys
      .filter((key) => key.toLowerCase().includes("webdriver"))
      .slice(0, 20);
    const automationLikeWindowKeys = windowKeys
      .filter((key) => {
        const lowerKey = key.toLowerCase();
        return (
          lowerKey.includes("playwright") ||
          lowerKey.includes("puppeteer") ||
          lowerKey.includes("selenium") ||
          lowerKey.includes("chromedriver")
        );
      })
      .slice(0, 20);
    const permissionQuery = navigator.permissions?.query;
    const permissionQueryIsNative =
      typeof permissionQuery === "function"
        ? permissionQuery.toString().includes("[native code]")
        : undefined;

    return {
      ...(typeof navigator.webdriver === "boolean"
        ? { navigatorWebdriver: navigator.webdriver }
        : {}),
      userAgentContainsHeadless: navigator.userAgent.toLowerCase().includes("headless"),
      languagesLength: navigator.languages?.length ?? 0,
      pluginsLength: navigator.plugins?.length ?? 0,
      hasChromeRuntime:
        typeof windowRecord["chrome"] === "object" &&
        windowRecord["chrome"] !== null &&
        "runtime" in windowRecord["chrome"],
      ...(permissionQueryIsNative !== undefined ? { permissionQueryIsNative } : {}),
      hasPlaywrightBinding: "__playwright__binding__" in windowRecord,
      hasPwInitScripts: "__pwInitScripts" in windowRecord,
      cdcKeys,
      webdriverKeys,
      automationLikeWindowKeys,
    };
  });
}

function toStorageCounterMap(
  entries: ReadonlyArray<StorageEntrySummary>,
): ReadonlyMap<string, StorageEntrySummary> {
  return new Map(entries.map((entry) => [`${entry.area}:${entry.key}`, entry] as const));
}

function uniqueRecordKeys(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): string[] {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
}

function buildNumericDelta(
  before: number | undefined,
  after: number | undefined,
): z.infer<typeof NumericFieldDeltaSchema> {
  return {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined && after !== undefined ? { delta: after - before } : {}),
  };
}

function buildArrayLengthDelta(
  before: number | undefined,
  after: number | undefined,
): z.infer<typeof ArrayLengthDeltaSchema> {
  return {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined && after !== undefined ? { delta: after - before } : {}),
  };
}

export function diffStorageCounters(
  beforeEntries: ReadonlyArray<StorageEntrySummary>,
  afterEntries: ReadonlyArray<StorageEntrySummary>,
): StorageCounterDiff[] {
  const beforeMap = toStorageCounterMap(beforeEntries);
  const afterMap = toStorageCounterMap(afterEntries);
  const entryIds = [...new Set([...beforeMap.keys(), ...afterMap.keys()])];
  const diffs: StorageCounterDiff[] = [];

  for (const entryId of entryIds) {
    const before = beforeMap.get(entryId);
    const after = afterMap.get(entryId);
    const source = after ?? before;
    if (!source) {
      continue;
    }

    const numericDeltas: Record<string, NumericFieldDelta> = {};
    for (const key of uniqueRecordKeys(before?.numericFields, after?.numericFields)) {
      const beforeValue = before?.numericFields?.[key];
      const afterValue = after?.numericFields?.[key];
      if (beforeValue !== afterValue) {
        numericDeltas[key] = buildNumericDelta(beforeValue, afterValue);
      }
    }

    const booleanChanges: Record<string, BooleanFieldChange> = {};
    for (const key of uniqueRecordKeys(before?.booleanFields, after?.booleanFields)) {
      const beforeValue = before?.booleanFields?.[key];
      const afterValue = after?.booleanFields?.[key];
      if (beforeValue !== afterValue) {
        booleanChanges[key] = {
          ...(beforeValue !== undefined ? { before: beforeValue } : {}),
          ...(afterValue !== undefined ? { after: afterValue } : {}),
        };
      }
    }

    const arrayLengthDeltas: Record<string, ArrayLengthDelta> = {};
    for (const key of uniqueRecordKeys(before?.arrayLengths, after?.arrayLengths)) {
      const beforeValue = before?.arrayLengths?.[key];
      const afterValue = after?.arrayLengths?.[key];
      if (beforeValue !== afterValue) {
        arrayLengthDeltas[key] = buildArrayLengthDelta(beforeValue, afterValue);
      }
    }

    if (
      before !== undefined &&
      after !== undefined &&
      Object.keys(numericDeltas).length === 0 &&
      Object.keys(booleanChanges).length === 0 &&
      Object.keys(arrayLengthDeltas).length === 0
    ) {
      continue;
    }

    diffs.push({
      area: source.area,
      key: source.key,
      beforePresent: before !== undefined,
      afterPresent: after !== undefined,
      ...(Object.keys(numericDeltas).length > 0 ? { numericDeltas } : {}),
      ...(Object.keys(booleanChanges).length > 0 ? { booleanChanges } : {}),
      ...(Object.keys(arrayLengthDeltas).length > 0 ? { arrayLengthDeltas } : {}),
    });
  }

  return diffs;
}

async function readStorageSummary(page: Page, counterBaseline: ReadonlyArray<StorageEntrySummary>) {
  const [localStorageEntries, sessionStorageEntries, cookies] = await Promise.all([
    readStorageEntries(page, "localStorage"),
    readStorageEntries(page, "sessionStorage"),
    page.context().cookies(),
  ]);
  const localCounterAfterEntries = localStorageEntries
    .filter((entry) => isSecurityCounterStorageKey(entry.key))
    .map((entry) => summarizeStorageEntry("localStorage", entry));
  const sessionCounterAfterEntries = sessionStorageEntries
    .filter((entry) => isSecurityCounterStorageKey(entry.key))
    .map((entry) => summarizeStorageEntry("sessionStorage", entry));
  const counterAfterEntries = [...localCounterAfterEntries, ...sessionCounterAfterEntries];

  return {
    localStorage: localStorageEntries.map((entry) => summarizeStorageEntry("localStorage", entry)),
    sessionStorage: sessionStorageEntries.map((entry) =>
      summarizeStorageEntry("sessionStorage", entry),
    ),
    cookies: cookies
      .filter(
        (cookie) =>
          cookie.domain.includes("zhipin.com") || cookie.domain.includes("bosszhipin.com"),
      )
      .map((cookie) => summarizeCookie(cookie)),
    counterDiffs: diffStorageCounters(counterBaseline, counterAfterEntries),
  };
}

export const zhipinDiagnoseBrowserState = defineTool({
  name: "zhipin_diagnose_browser_state",
  description:
    "分阶段诊断 Boss 页面在原生 CDP page WebSocket、Playwright CDP attach、页面绑定、网络上报、evaluate、检测指纹、storage/cookie 读取时的状态；默认只做 native target 枚举，所有 storage/cookie 值均脱敏。",
  input: ZhipinDiagnoseBrowserStateInputSchema,
  output: ZhipinDiagnoseBrowserStateOutputSchema,
  execute: async (input, ctx) => {
    const requestedPhase = input.phase ?? "native";
    const watchMs = input.watchMs ?? 3_000;
    const networkEventLimit = input.networkEventLimit ?? 30;
    const ctxManager = getContextManager();
    const runtime = getRuntime();
    const warnings: string[] = [];
    const phases: DiagnosticPhaseResult[] = [];
    const nativeTimeline: NativeTargetSnapshot[] = [];
    let browserAttached = false;
    let pageAttached = false;
    let targetPage: BrowserPageInfo | undefined;
    let targetPageId = input.targetPageId;
    let networkEvents: NetworkEventSummary[] | undefined;
    let navigationEvents: NavigationEventSummary[] | undefined;

    ctx.logger.info(`Diagnosing zhipin browser state (phase: ${requestedPhase})`);

    const nativePhase = await measurePhase(
      "native",
      async () => await ctxManager.listNativePages(),
    );
    phases.push(nativePhase.phaseResult);
    const nativeInspectablePages = nativePhase.result ?? [];
    const nativePages = nativeInspectablePages.map((page) => toNativePageInfo(ctxManager, page));
    const target = resolveNativeZhipinTarget(nativeInspectablePages, input.targetPageId, warnings);
    if (target) {
      targetPage = toNativePageInfo(ctxManager, target);
      targetPageId = target.targetId;
      nativeTimeline.push(createNativeTargetSnapshot(ctxManager, "native", target, undefined));
    }

    if (!nativePhase.phaseResult.success || requestedPhase === "native") {
      return {
        success: nativePhase.phaseResult.success,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    if (requestedPhase === "native-watch") {
      await appendNativeWatchSnapshots(
        ctxManager,
        nativeTimeline,
        "native-watch",
        targetPageId,
        watchMs,
        warnings,
      );
      return {
        success: nativePhase.phaseResult.success && targetPageId !== undefined,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    if (!target) {
      return {
        success: false,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    if (isNativeCdpDiagnosticPhase(requestedPhase)) {
      const nativeCdpProbe = await runNativeCdpProbe({
        requestedPhase,
        target,
        runtime,
        ctxManager,
        targetPageId,
        watchMs,
        phases,
        nativeTimeline,
        warnings,
      });

      return {
        success: phases.every((phase) => phase.success) && !nativeCdpProbe.triggeredNavigation,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        nativeCdp: nativeCdpProbe.summary,
        phases,
        warnings,
      };
    }

    if (requestedPhase === "resume-canvas") {
      const resumePhase = await measurePhase("resume-canvas", async () => {
        const nativePage = await openZhipinNativePagePort();
        try {
          const dialogState = await nativePage.waitForResumeDialog(1_000);
          const geometry = dialogState.canvasReady
            ? await nativePage.readResumeCanvasGeometry()
            : undefined;
          return { dialogState, geometry };
        } finally {
          nativePage.close();
        }
      });
      phases.push(resumePhase.phaseResult);
      const probe = resumePhase.result;
      return {
        success: resumePhase.phaseResult.success,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        ...(probe !== undefined
          ? {
              resumeCanvas: {
                dialogVisible: probe.dialogState.dialogVisible,
                iframeFound: probe.dialogState.iframeFound,
                iframeVisible: probe.dialogState.iframeVisible,
                canvasReady: probe.dialogState.canvasReady,
                ...(probe.geometry?.screenshotArea !== undefined
                  ? { screenshotArea: probe.geometry.screenshotArea }
                  : {}),
                ...(probe.geometry?.canvasSize !== undefined
                  ? { canvasSize: probe.geometry.canvasSize }
                  : {}),
                ...(probe.geometry?.error !== undefined ? { error: probe.geometry.error } : {}),
              },
            }
          : {}),
        phases,
        warnings,
      };
    }

    const browserPhase = await measurePhase(
      "browser-attach",
      async () => await runtime.getBrowser(),
    );
    phases.push(browserPhase.phaseResult);
    const browser = browserPhase.result;
    browserAttached = browserPhase.phaseResult.success;
    await appendNativeSnapshot(
      ctxManager,
      nativeTimeline,
      "browser-attach",
      targetPageId,
      warnings,
    );

    const browserAttachTriggeredNavigation = await appendNativeWatchSnapshots(
      ctxManager,
      nativeTimeline,
      "browser-attach-watch",
      targetPageId,
      watchMs,
      warnings,
    );
    if (browserAttachTriggeredNavigation) {
      warnings.push(
        "Browser attach was followed by a native URL change; treat this account/browser profile as unsafe for Playwright-backed zhipin tools.",
      );
    }

    if (!browserPhase.phaseResult.success || requestedPhase === "browser-attach") {
      return {
        success: phases.every((phase) => phase.success) && !browserAttachTriggeredNavigation,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    if (browserAttachTriggeredNavigation) {
      return {
        success: false,
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    const networkWatchers: Array<Promise<NetworkWatchResult>> = [];
    let preAttachNetworkPage: Page | undefined;
    if (requestedPhase === "network-watch" && browser !== undefined) {
      preAttachNetworkPage = findAttachedPageForNativeTarget(browser, target);
      if (preAttachNetworkPage) {
        networkWatchers.push(
          watchRelevantNetworkEvents(preAttachNetworkPage, watchMs, networkEventLimit),
        );
      } else {
        warnings.push(
          "No attached zhipin page found before page-attach; network-watch starts after page-attach.",
        );
      }
    }

    ctxManager.rememberNativePageSelection("zhipin", target);

    const pagePhase = await measurePhase(
      "page-attach",
      async () => await ctxManager.getPage("zhipin"),
    );
    phases.push(pagePhase.phaseResult);
    const attachedPage = pagePhase.result;
    pageAttached = pagePhase.phaseResult.success;

    if (attachedPage) {
      targetPage = await toAttachedPageInfo(ctxManager, attachedPage);
    }
    await appendNativeSnapshot(ctxManager, nativeTimeline, "page-attach", targetPageId, warnings);

    if (!pagePhase.phaseResult.success || !attachedPage) {
      if (requestedPhase === "network-watch" && networkWatchers.length > 0) {
        const networkPhase = await measurePhase("network-watch", async () =>
          mergeNetworkWatchResults(await Promise.all(networkWatchers), networkEventLimit),
        );
        phases.push(networkPhase.phaseResult);
        if (networkPhase.result) {
          networkEvents = networkPhase.result.networkEvents;
          navigationEvents = networkPhase.result.navigationEvents;
        }
      }
      return {
        success: phases.every((phase) => phase.success),
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        ...(networkEvents !== undefined ? { networkEvents } : {}),
        ...(navigationEvents !== undefined ? { navigationEvents } : {}),
        phases,
        warnings,
      };
    }

    if (requestedPhase === "page-attach") {
      return {
        success: phases.every((phase) => phase.success),
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        phases,
        warnings,
      };
    }

    if (requestedPhase === "network-watch") {
      if (preAttachNetworkPage !== attachedPage) {
        networkWatchers.push(watchRelevantNetworkEvents(attachedPage, watchMs, networkEventLimit));
      }
      const networkPhase = await measurePhase("network-watch", async () =>
        mergeNetworkWatchResults(await Promise.all(networkWatchers), networkEventLimit),
      );
      phases.push(networkPhase.phaseResult);
      if (networkPhase.result) {
        networkEvents = networkPhase.result.networkEvents;
        navigationEvents = networkPhase.result.navigationEvents;
      }
      await appendNativeSnapshot(
        ctxManager,
        nativeTimeline,
        "network-watch",
        targetPageId,
        warnings,
      );

      return {
        success: phases.every((phase) => phase.success),
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        ...(networkEvents !== undefined ? { networkEvents } : {}),
        ...(navigationEvents !== undefined ? { navigationEvents } : {}),
        phases,
        warnings,
      };
    }

    let counterBaseline: ReadonlyArray<StorageEntrySummary> = [];
    if (requestedPhase === "storage-summary") {
      try {
        counterBaseline = await readSecurityCounterEntries(attachedPage);
      } catch (error) {
        warnings.push(
          `Failed to read storage counter baseline: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
      }
      if (watchMs > 0) {
        await delay(watchMs);
      }
    }

    const evaluatePhase = await measurePhase(
      "page-evaluate",
      async () => await readPageEvaluateSummary(attachedPage),
    );
    phases.push(evaluatePhase.phaseResult);
    const evaluate = evaluatePhase.result;
    await appendNativeSnapshot(ctxManager, nativeTimeline, "page-evaluate", targetPageId, warnings);

    if (!evaluatePhase.phaseResult.success || requestedPhase === "page-evaluate") {
      return {
        success: phases.every((phase) => phase.success),
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        ...(evaluate !== undefined ? { evaluate } : {}),
        phases,
        warnings,
      };
    }

    const detectorPhase = await measurePhase(
      "detector-fingerprint",
      async () => await readDetectorFingerprintSummary(attachedPage),
    );
    phases.push(detectorPhase.phaseResult);
    const detectorFingerprint = detectorPhase.result;
    await appendNativeSnapshot(
      ctxManager,
      nativeTimeline,
      "detector-fingerprint",
      targetPageId,
      warnings,
    );

    if (!detectorPhase.phaseResult.success || requestedPhase === "detector-fingerprint") {
      return {
        success: phases.every((phase) => phase.success),
        requestedPhase,
        mode: runtime.mode,
        nativePages,
        ...(targetPage !== undefined ? { targetPage } : {}),
        browserAttached,
        pageAttached,
        nativeTimeline,
        ...(evaluate !== undefined ? { evaluate } : {}),
        ...(detectorFingerprint !== undefined ? { detectorFingerprint } : {}),
        phases,
        warnings,
      };
    }

    const storagePhase = await measurePhase(
      "storage-summary",
      async () => await readStorageSummary(attachedPage, counterBaseline),
    );
    phases.push(storagePhase.phaseResult);
    const storage = storagePhase.result;
    await appendNativeSnapshot(
      ctxManager,
      nativeTimeline,
      "storage-summary",
      targetPageId,
      warnings,
    );

    return {
      success: phases.every((phase) => phase.success),
      requestedPhase,
      mode: runtime.mode,
      nativePages,
      ...(targetPage !== undefined ? { targetPage } : {}),
      browserAttached,
      pageAttached,
      nativeTimeline,
      ...(evaluate !== undefined ? { evaluate } : {}),
      ...(detectorFingerprint !== undefined ? { detectorFingerprint } : {}),
      ...(storage !== undefined ? { storage } : {}),
      phases,
      warnings,
    };
  },
});
