import type { TurnPlan } from "../types/reply-policy.ts";
import type { CandidateInfo } from "../types/zhipin.ts";

export function parseAge(ageStr?: string): string | undefined {
  if (!ageStr) return undefined;
  const match = ageStr.match(/(\d+)/);
  return match ? match[1] : ageStr;
}

export function resolveCandidateAge(
  turnPlan: TurnPlan,
  candidateInfo?: CandidateInfo,
): number | undefined {
  if (typeof candidateInfo?.age === "number") {
    return candidateInfo.age;
  }
  const parsedAge = parseAge(candidateInfo?.age);
  if (parsedAge) {
    const age = Number(parsedAge);
    if (Number.isFinite(age)) return age;
  }
  if (typeof turnPlan.extractedInfo.specificAge === "number") {
    return turnPlan.extractedInfo.specificAge;
  }
  return undefined;
}

export function resolveRegionName(
  turnPlan: TurnPlan,
  candidateInfo?: CandidateInfo,
): string | undefined {
  const district = turnPlan.extractedInfo.mentionedDistricts?.[0]?.district;
  if (district) return district;
  const location = turnPlan.extractedInfo.mentionedLocations?.[0]?.location;
  if (location) return location;
  if (candidateInfo?.jobAddress) return candidateInfo.jobAddress;
  return undefined;
}
