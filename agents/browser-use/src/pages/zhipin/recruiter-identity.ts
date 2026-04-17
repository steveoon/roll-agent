import type { Page } from "@roll-agent/browser";
import {
  collectUsernameEvidence,
  pickBestUsername,
  type UsernameEvidence,
  type UsernameStrategy,
} from "./username.ts";
import type { RecruiterBinding } from "../../reply-authority/schemas.ts";

export interface ZhipinRecruiterIdentity {
  readonly platform: "zhipin";
  readonly username: string;
  readonly accountId?: string;
  readonly strategy: UsernameStrategy;
  readonly source: string;
}

type UsernameEvidenceCollector = (page: Page) => Promise<ReadonlyArray<UsernameEvidence>>;

export async function getCurrentZhipinRecruiterIdentity(
  page: Page,
  collectEvidence: UsernameEvidenceCollector = collectUsernameEvidence,
): Promise<ZhipinRecruiterIdentity> {
  const evidence = await collectEvidence(page);
  const result = pickBestUsername(evidence);

  if (!result.found) {
    throw new Error("未找到用户名，请确认当前页面已登录招聘者账号。");
  }

  return {
    platform: "zhipin",
    username: result.username,
    strategy: result.strategy,
    source: result.source,
  };
}

export function matchesRecruiterBinding(
  current: Pick<ZhipinRecruiterIdentity, "username" | "accountId">,
  binding: RecruiterBinding,
): boolean {
  if (binding.accountId !== undefined) {
    return current.accountId === binding.accountId;
  }

  return current.username === binding.username;
}
