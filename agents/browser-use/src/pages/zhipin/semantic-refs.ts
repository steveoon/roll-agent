export const ZHIPIN_CANDIDATE_REF_PREFIX = "@c" as const;

export const ZHIPIN_CANDIDATE_REF_PATTERN = /^@?c([1-9]\d*)$/i;

export interface ZhipinCandidateRefSource {
  readonly index: number;
  readonly candidateId: string;
  readonly name?: string;
}

export interface ZhipinCandidateRefTarget extends ZhipinCandidateRefSource {
  readonly candidateRef: string;
}

let latestCandidateRefTargets = new Map<string, ZhipinCandidateRefTarget>();

export function buildZhipinCandidateRef(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("候选人索引必须是从 0 开始的非负整数");
  }

  return `${ZHIPIN_CANDIDATE_REF_PREFIX}${String(index + 1)}`;
}

export function parseZhipinCandidateRef(ref: string): number | undefined {
  const match = ZHIPIN_CANDIDATE_REF_PATTERN.exec(ref.trim());
  const rawOrdinal = match?.[1];
  if (!rawOrdinal) {
    return undefined;
  }

  const ordinal = Number(rawOrdinal);
  return Number.isInteger(ordinal) ? ordinal - 1 : undefined;
}

export function resolveZhipinCandidateIndex(input: {
  readonly index?: number | undefined;
  readonly candidateRef?: string | undefined;
}): number {
  if (input.index !== undefined) {
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw new Error("index 必须是从 0 开始的非负整数");
    }
    return input.index;
  }

  if (input.candidateRef === undefined) {
    throw new Error("必须提供 index 或 candidateRef");
  }

  return resolveZhipinCandidateRefTarget(input.candidateRef).index;
}

export function resolveZhipinCandidateIndices(input: {
  readonly indices?: readonly number[] | undefined;
  readonly candidateRefs?: readonly string[] | undefined;
}): number[] {
  return resolveZhipinCandidateTargets(input).map((target) => target.index);
}

export function rememberZhipinCandidateRefs(
  candidates: readonly ZhipinCandidateRefSource[],
): ZhipinCandidateRefTarget[] {
  const targets = candidates.map((candidate, position) => ({
    ...candidate,
    candidateRef: buildZhipinCandidateRef(position),
  }));
  latestCandidateRefTargets = new Map(targets.map((target) => [target.candidateRef, target]));
  return targets;
}

export function clearZhipinCandidateRefsForTests(): void {
  latestCandidateRefTargets = new Map();
}

export function resolveZhipinCandidateRefTarget(candidateRef: string): ZhipinCandidateRefTarget {
  const index = parseZhipinCandidateRef(candidateRef);
  if (index === undefined) {
    throw new Error(`candidateRef "${candidateRef}" 格式无效，应类似 @c1`);
  }

  const normalizedRef = buildZhipinCandidateRef(index);
  return (
    latestCandidateRefTargets.get(normalizedRef) ?? {
      index,
      candidateRef: normalizedRef,
      candidateId: "",
    }
  );
}

export function resolveZhipinCandidateTargets(input: {
  readonly indices?: readonly number[] | undefined;
  readonly candidateRefs?: readonly string[] | undefined;
}): ZhipinCandidateRefTarget[] {
  const resolved: ZhipinCandidateRefTarget[] = [];

  for (const index of input.indices ?? []) {
    resolved.push({
      index: resolveZhipinCandidateIndex({ index }),
      candidateRef: buildZhipinCandidateRef(index),
      candidateId: "",
    });
  }

  for (const candidateRef of input.candidateRefs ?? []) {
    resolved.push(resolveZhipinCandidateRefTarget(candidateRef));
  }

  if (resolved.length === 0) {
    throw new Error("必须提供 indices 或 candidateRefs");
  }

  return dedupeZhipinCandidateTargets(resolved);
}

export function isZhipinCandidateTargetCurrent(
  target: ZhipinCandidateRefTarget,
  current: {
    readonly found?: boolean;
    readonly candidateId: string;
    readonly name?: string;
  },
): boolean {
  if (current.found === false) {
    return false;
  }

  if (target.candidateId.length > 0 && current.candidateId.length > 0) {
    return target.candidateId === current.candidateId;
  }

  if (target.name && current.name && current.name.length > 0) {
    return normalizeCandidateName(target.name) === normalizeCandidateName(current.name);
  }

  return true;
}

function dedupeZhipinCandidateTargets(
  targets: readonly ZhipinCandidateRefTarget[],
): ZhipinCandidateRefTarget[] {
  const targetsByRef = new Map<string, ZhipinCandidateRefTarget>();
  for (const target of targets) {
    if (!targetsByRef.has(target.candidateRef)) {
      targetsByRef.set(target.candidateRef, target);
    }
  }
  return [...targetsByRef.values()];
}

function normalizeCandidateName(name: string): string {
  return name.trim().toLocaleLowerCase("zh-CN");
}
