import {
  DEFAULT_OUTPUT_GUARDS,
  type EffectiveDisclosureMode,
  type OutputGuardsPolicy,
  PRIMARY_NEED_FACT_MAP,
  type ReplyFactFamily,
  type ReplyNeed,
  type ReplyPolicyConfig,
} from "../types/reply-policy.ts";

export const REPLY_GATE_VIOLATION_CODES = [
  "too_many_questions",
  "audit_tone",
  "premature_numeric_disclosure",
  "off_axis_fact_disclosure",
  "reply_overpacked",
] as const;

export type ReplyGateViolationCode = (typeof REPLY_GATE_VIOLATION_CODES)[number];

export interface ReplyGateValidationResult {
  violations: ReplyGateViolationCode[];
  questionCount: number;
  factFamilies: ReplyFactFamily[];
}

interface FactFamilyPatternSet {
  mention: RegExp[];
  concrete: RegExp[];
}

const QUESTION_MARK_SEGMENT_PATTERN = /[^。！？!?]*[?？]/g;

const FACT_FAMILY_PATTERNS: Record<ReplyFactFamily, FactFamilyPatternSet> = {
  salary: {
    mention: [/\d+(?:\.\d+)?\s*元(?:\/时|\/小时)?/i, /时薪|薪资|工资|底薪|收入/i],
    concrete: [/\d+(?:\.\d+)?\s*元(?:\/时|\/小时)?/i],
  },
  schedule: {
    mention: [/\d{1,2}:\d{2}\s*[~-]\s*\d{1,2}:\d{2}/, /班次|轮班|白班|晚班|工时|排班/i],
    concrete: [/\d{1,2}:\d{2}\s*[~-]\s*\d{1,2}:\d{2}/, /轮班|白班|晚班|早班|中班|夜班/i],
  },
  location: {
    mention: [/地址|地铁|附近|位于|门店|在.+(?:路|街|广场|商场|大厦)/i],
    concrete: [/地址|位于|地铁\S*站|在.+(?:路|街|广场|商场|大厦)/i],
  },
  policy: {
    mention: [/考勤|试用期|社保|五险一金|迟到|补班/i],
    concrete: [/考勤|试用期|社保|五险一金|迟到|补班/i],
  },
  requirements: {
    mention: [/年龄|学历|经验|健康证|要求/i],
    concrete: [/年龄|学历|经验|健康证/i],
  },
  availability: {
    mention: [/名额|空位|可用时段|可安排/i],
    concrete: [/名额|空位|可用时段/i],
  },
};

function resolveOutputGuards(policy?: ReplyPolicyConfig): OutputGuardsPolicy {
  return policy?.outputGuards ?? DEFAULT_OUTPUT_GUARDS;
}

export function countQuestions(text: string): number {
  const questionMarkSegments = text.match(QUESTION_MARK_SEGMENT_PATTERN) ?? [];
  const normalizedQuestionMarkSegments = new Set(
    questionMarkSegments.map((segment) => segment.replace(/[?？]/g, "").trim()).filter(Boolean),
  );
  const endingQuestions = text
    .split(/[。！？!?]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((clause) => /[吗呢么]$/.test(clause) && !normalizedQuestionMarkSegments.has(clause)).length;

  return questionMarkSegments.length + endingQuestions;
}

function countSentences(text: string): number {
  return text
    .split(/[。！？!?]/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function hasListMarkers(text: string): boolean {
  return /(?:^|\s)(?:\d+\.\s|- |•)/m.test(text);
}

function detectFactFamilies(
  text: string,
  matchMode: keyof FactFamilyPatternSet = "mention",
): ReplyFactFamily[] {
  return Object.entries(FACT_FAMILY_PATTERNS)
    .filter(([, patterns]) => patterns[matchMode].some((pattern) => pattern.test(text)))
    .map(([family]) => family as ReplyFactFamily);
}

function hasBlockedAuditPhrase(text: string, blockedPhrases: string[]): boolean {
  return blockedPhrases.some((phrase) => phrase && text.includes(phrase));
}

function hasFirstTurnSpecificFacts(text: string): boolean {
  return (
    /\d+(?:\.\d+)?\s*元(?:\/时|\/小时)?/i.test(text) ||
    /\d{1,2}:\d{2}\s*[~-]\s*\d{1,2}:\d{2}/.test(text) ||
    /年龄\s*\d{1,2}\s*[-~到]\s*\d{1,2}\s*岁/i.test(text) ||
    /\d{1,2}\s*[-~到]\s*\d{1,2}\s*岁/i.test(text) ||
    /地址在|门店在|位于|在.+(?:路|街|广场|商场|大厦|地铁)/i.test(text)
  );
}

function isReplyOverpacked(
  text: string,
  questionCount: number,
  factFamilies: ReplyFactFamily[],
): boolean {
  let signals = 0;
  if (countSentences(text) >= 4) signals += 1;
  if (hasListMarkers(text)) signals += 1;
  if (questionCount >= 3) signals += 1;
  if (factFamilies.length >= 2) signals += 1;
  return signals >= 2;
}

export function detectConcreteFactFamilies(text: string): ReplyFactFamily[] {
  return detectFactFamilies(text, "concrete");
}

export function detectContextFactFamilies(contextInfo: string): ReplyFactFamily[] {
  const families: ReplyFactFamily[] = [];
  if (/薪资：/.test(contextInfo)) families.push("salary");
  if (/排班：|时间：|每周工时：/.test(contextInfo)) families.push("schedule");
  if (/匹配到的门店信息：[\s\S]*• .*：/.test(contextInfo)) families.push("location");
  if (/考勤：|出勤要求：/.test(contextInfo)) families.push("policy");
  if (/要求：/.test(contextInfo)) families.push("requirements");
  if (/可用时段：/.test(contextInfo)) families.push("availability");
  return families;
}

function hasOffAxisFactDisclosure(
  allowedNeeds: ReplyNeed[],
  factFamilies: ReplyFactFamily[],
): boolean {
  const allowedFamilies = new Set<ReplyFactFamily>(
    allowedNeeds.flatMap((need) => PRIMARY_NEED_FACT_MAP[need]),
  );
  if (allowedFamilies.size === 0) return factFamilies.length > 0;
  return factFamilies.some((family) => !allowedFamilies.has(family));
}

export function validateReply(options: {
  text: string;
  turnIndex: number;
  mode: EffectiveDisclosureMode;
  primaryNeed: ReplyNeed;
  allowedNeeds?: ReplyNeed[] | undefined;
  policy?: ReplyPolicyConfig | undefined;
}): ReplyGateValidationResult {
  const { text, turnIndex, mode, policy } = options;
  const outputGuards = resolveOutputGuards(policy);
  const questionCount = countQuestions(text);
  const maxQuestions = outputGuards.maxQuestionsByMode[mode];
  const factFamilies = detectConcreteFactFamilies(text);
  const allowedNeeds = options.allowedNeeds?.length ? options.allowedNeeds : [options.primaryNeed];
  const violations: ReplyGateViolationCode[] = [];

  if (questionCount > maxQuestions) violations.push("too_many_questions");
  if (hasBlockedAuditPhrase(text, outputGuards.blockedAuditPhrases)) violations.push("audit_tone");
  if (
    outputGuards.blockFirstTurnSpecificFacts &&
    turnIndex === 1 &&
    hasFirstTurnSpecificFacts(text)
  ) {
    violations.push("premature_numeric_disclosure");
  }
  if (hasOffAxisFactDisclosure(allowedNeeds, factFamilies)) {
    violations.push("off_axis_fact_disclosure");
  }
  if (isReplyOverpacked(text, questionCount, factFamilies)) {
    violations.push("reply_overpacked");
  }

  return {
    violations,
    questionCount,
    factFamilies,
  };
}
