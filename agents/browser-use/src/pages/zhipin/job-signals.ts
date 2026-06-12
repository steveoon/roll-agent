import type { CandidateLocationSignal } from "@roll-agent/reply-authority-client";

const EXPECTED_JOB_SEPARATOR = "·";
const BRAND_POSITION_SEPARATOR = /[-－—–]/;
const BRAND_ID_SUFFIX_PATTERN = /[[【［]\s*(\d+)\s*[\]】］]\s*$/;

export const LocationSignalAnalysisPathValues = [
  "llm",
  "fallback",
  "profile_only",
  "speculative",
  "none",
] as const;

export type LocationSignalAnalysisPath = (typeof LocationSignalAnalysisPathValues)[number];

export const LocationSignalInquiryTypeValues = [
  "location_inquiry",
  "non_location_inquiry",
] as const;

export type LocationSignalInquiryType = (typeof LocationSignalInquiryTypeValues)[number];

export type LocationSignalResolution = {
  readonly signals: readonly CandidateLocationSignal[];
  readonly analysisPath: LocationSignalAnalysisPath;
  readonly inquiryType?: LocationSignalInquiryType;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function hasStrongLocationSignals(signals: readonly CandidateLocationSignal[]): boolean {
  return signals.some((signal) => signal.source !== "candidate_expected_location");
}

function formatLocationSignalParts(signals: readonly CandidateLocationSignal[]): string {
  const hasStrongSignals = hasStrongLocationSignals(signals);
  const displaySignals = hasStrongSignals
    ? signals.filter((signal) => signal.source !== "candidate_expected_location")
    : signals;
  const parts = displaySignals.slice(0, 3).map((signal) => {
    const weakMarker = signal.source === "candidate_expected_location" ? "（弱）" : "";
    return `${signal.text}${weakMarker}`;
  });
  const overflow = displaySignals.length > 3 ? ` 等${String(displaySignals.length)}项` : "";
  return `${parts.join("、")}${overflow}`;
}

function isLocationSignalResolution(
  value: LocationSignalResolution | readonly CandidateLocationSignal[],
): value is LocationSignalResolution {
  return !Array.isArray(value) && "analysisPath" in value && "signals" in value;
}

export function formatLocationSignalsVisualLabel(
  resolution: LocationSignalResolution | readonly CandidateLocationSignal[],
): string {
  const signals = isLocationSignalResolution(resolution) ? resolution.signals : resolution;
  const analysisPath = isLocationSignalResolution(resolution) ? resolution.analysisPath : undefined;
  const inquiryType = isLocationSignalResolution(resolution) ? resolution.inquiryType : undefined;

  if (signals.length === 0) {
    if (inquiryType === "non_location_inquiry") {
      return "非地点咨询";
    }
    return analysisPath === "profile_only" ? "" : "未识别到地点线索";
  }

  const summary = formatLocationSignalParts(signals);
  const onlyWeakProfileSignals = !hasStrongLocationSignals(signals);

  if (onlyWeakProfileSignals) {
    if (analysisPath === "profile_only") {
      return `资料城市提示：${summary}`;
    }
    return "未识别到地点线索";
  }

  if (analysisPath === "fallback") {
    return `已识别地点（兜底）：${summary}`;
  }

  return `已识别地点：${summary}`;
}

export function resolvePreferredBrandId(communicationPosition: string): number | undefined {
  const match = BRAND_ID_SUFFIX_PATTERN.exec(normalizeText(communicationPosition));
  if (!match) {
    return undefined;
  }

  const brandId = Number(match[1]);
  return Number.isSafeInteger(brandId) && brandId > 0 ? brandId : undefined;
}

export function resolvePreferredBrand(communicationPosition: string): string | undefined {
  const normalizedPosition = normalizeText(communicationPosition);
  if (!normalizedPosition || BRAND_ID_SUFFIX_PATTERN.test(normalizedPosition)) {
    return undefined;
  }
  if (!BRAND_POSITION_SEPARATOR.test(normalizedPosition)) {
    return undefined;
  }

  const [preferredBrand = ""] = normalizedPosition.split(BRAND_POSITION_SEPARATOR);
  const normalizedBrand = normalizeText(preferredBrand);

  return normalizedBrand || undefined;
}

export function resolveExpectedSignals(expectedJobText: string): {
  expectedLocation: string;
  expectedPosition: string;
} {
  const normalizedText = normalizeText(expectedJobText);
  if (!normalizedText) {
    return {
      expectedLocation: "",
      expectedPosition: "",
    };
  }

  const [expectedLocation = "", expectedPosition = ""] = normalizedText
    .split(EXPECTED_JOB_SEPARATOR)
    .map((part) => normalizeText(part));

  return {
    expectedLocation,
    expectedPosition,
  };
}

export function resolveConversationSignals(input: {
  communicationPosition: string;
  expectedJobText: string;
}): {
  communicationPosition: string;
  expectedLocation: string;
  expectedPosition: string;
  preferredBrand?: string;
  preferredBrandId?: number;
} {
  const communicationPosition = normalizeText(input.communicationPosition);
  const { expectedLocation, expectedPosition } = resolveExpectedSignals(input.expectedJobText);
  const preferredBrand = resolvePreferredBrand(communicationPosition);
  const preferredBrandId = resolvePreferredBrandId(communicationPosition);

  return {
    communicationPosition,
    expectedLocation,
    expectedPosition,
    ...(preferredBrand !== undefined ? { preferredBrand } : {}),
    ...(preferredBrandId !== undefined ? { preferredBrandId } : {}),
  };
}
