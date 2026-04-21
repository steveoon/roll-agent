const BRAND_ALIAS_TO_NAME = {
  KFC: "肯德基",
  kfc: "肯德基",
  肯德基: "肯德基",
  McCafe: "麦咖啡",
  mccafe: "麦咖啡",
  MCDONALDS: "麦当劳",
  McDonalds: "麦当劳",
  Mcdonalds: "麦当劳",
  mcdonalds: "麦当劳",
  麦当劳: "麦当劳",
  必胜客: "必胜客",
  PizzaHut: "必胜客",
  pizzahut: "必胜客",
  星巴克: "星巴克",
  Starbucks: "星巴克",
  starbucks: "星巴克",
} as const;

const COMMUNICATION_POSITION_SEPARATOR = /[\s\-－—–]+/;
const EXPECTED_JOB_SEPARATOR = "·";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function extractFirstSegment(value: string): string {
  const [firstSegment = ""] = value.split(COMMUNICATION_POSITION_SEPARATOR);
  return normalizeText(firstSegment);
}

export function resolvePreferredBrand(communicationPosition: string): string | undefined {
  const normalizedPosition = normalizeText(communicationPosition);
  if (!normalizedPosition) {
    return undefined;
  }

  const firstSegment = extractFirstSegment(normalizedPosition);
  if (!firstSegment) {
    return undefined;
  }

  return BRAND_ALIAS_TO_NAME[firstSegment as keyof typeof BRAND_ALIAS_TO_NAME];
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
} {
  const communicationPosition = normalizeText(input.communicationPosition);
  const { expectedLocation, expectedPosition } = resolveExpectedSignals(input.expectedJobText);
  const preferredBrand = resolvePreferredBrand(communicationPosition);

  return {
    communicationPosition,
    expectedLocation,
    expectedPosition,
    ...(preferredBrand !== undefined ? { preferredBrand } : {}),
  };
}
