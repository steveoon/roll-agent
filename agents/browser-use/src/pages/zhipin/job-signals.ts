const EXPECTED_JOB_SEPARATOR = "·";
const BRAND_POSITION_SEPARATOR = /[-－—–]/;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function resolvePreferredBrand(communicationPosition: string): string | undefined {
  const normalizedPosition = normalizeText(communicationPosition);
  if (!normalizedPosition || !BRAND_POSITION_SEPARATOR.test(normalizedPosition)) {
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
