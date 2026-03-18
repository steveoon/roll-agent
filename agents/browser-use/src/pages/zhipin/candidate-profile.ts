import type { Page } from "@roll-agent/browser";
import { waitForSelector } from "@roll-agent/browser";
import { ZHIPIN_SELECTORS } from "./selectors.ts";

export interface CandidateProfile {
  readonly name?: string;
  readonly age?: string;
  readonly gender?: string;
  readonly experience?: string;
  readonly education?: string;
  readonly expectedSalary?: string;
  readonly expectedPosition?: string;
  readonly activeTime?: string;
  readonly fullText?: string;
}

/** 从候选人资料面板解析信息 */
export async function parseCandidateProfile(page: Page): Promise<CandidateProfile> {
  const sel = ZHIPIN_SELECTORS.candidateProfile;

  try {
    await waitForSelector(page, sel.panel, { timeout: 10_000 });
  } catch {
    return { fullText: "" };
  }

  const extractText = async (selector: string): Promise<string | undefined> => {
    try {
      const el = await page.$(selector);
      if (!el) return undefined;
      const text = await el.textContent();
      return text?.trim() || undefined;
    } catch {
      return undefined;
    }
  };

  const [name, age, gender, experience, education, expectedSalary, expectedPosition, activeTime] =
    await Promise.all([
      extractText(sel.name),
      extractText(sel.age),
      extractText(sel.gender),
      extractText(sel.experience),
      extractText(sel.education),
      extractText(sel.expectedSalary),
      extractText(sel.expectedPosition),
      extractText(sel.activeTime),
    ]);

  // 获取面板全文作为兜底
  let fullText: string | undefined;
  try {
    const panelEl = await page.$(sel.panel);
    if (panelEl) {
      fullText = (await panelEl.textContent())?.trim() || undefined;
    }
  } catch {
    // ignore
  }

  // exactOptionalPropertyTypes: optional 属性不能设为 undefined，须条件展开
  const result: CandidateProfile = {
    ...(name !== undefined ? { name } : {}),
    ...(age !== undefined ? { age } : {}),
    ...(gender !== undefined ? { gender } : {}),
    ...(experience !== undefined ? { experience } : {}),
    ...(education !== undefined ? { education } : {}),
    ...(expectedSalary !== undefined ? { expectedSalary } : {}),
    ...(expectedPosition !== undefined ? { expectedPosition } : {}),
    ...(activeTime !== undefined ? { activeTime } : {}),
    ...(fullText !== undefined ? { fullText } : {}),
  };
  return result;
}
