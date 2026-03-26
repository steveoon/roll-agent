import type { CandidateInfo } from "../types/zhipin.ts";

export interface KnownCandidateContext {
  /** 写入 user prompt 的已知事实文本，空字符串表示无已知信息 */
  factsText: string;
  /** 已知字段的中文标签列表，用于 system prompt 的"不得追问"约束 */
  knownFieldNames: string[];
}

const CANDIDATE_FIELD_MAP: Array<{
  key: keyof CandidateInfo;
  label: string;
}> = [
  { key: "age", label: "年龄" },
  { key: "gender", label: "性别" },
  { key: "education", label: "学历" },
  { key: "experience", label: "工作经验" },
  { key: "expectedSalary", label: "期望薪资" },
  { key: "expectedLocation", label: "期望位置" },
  { key: "jobAddress", label: "工作地址" },
  { key: "healthCertificate", label: "健康证" },
];

export function buildKnownCandidateContext(
  candidateInfo?: CandidateInfo,
): KnownCandidateContext {
  if (!candidateInfo) return { factsText: "", knownFieldNames: [] };

  const fields: Array<{ label: string; value: string }> = [];
  for (const { key, label } of CANDIDATE_FIELD_MAP) {
    const raw = candidateInfo[key];
    if (typeof raw === "string" && raw.trim()) {
      fields.push({ label, value: raw.trim() });
    } else if (typeof raw === "boolean") {
      fields.push({ label, value: raw ? "是" : "否" });
    }
  }

  if (fields.length === 0) return { factsText: "", knownFieldNames: [] };

  return {
    factsText: fields.map((f) => `${f.label}：${f.value}`).join("\n"),
    knownFieldNames: fields.map((f) => f.label),
  };
}
