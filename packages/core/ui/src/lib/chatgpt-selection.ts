import type { JsonObject } from "../types.ts";
import { getAtPath, setAtPath, deleteAtPath } from "./config-value.ts";

/** Choosing an account is not consent to change the shared runtime provider. */
export function selectChatGptAccount(draft: JsonObject, accountId: string): JsonObject {
  const selected = setAtPath(draft, ["runtime", "chatgptAccountId"], accountId);
  return getAtPath(draft, ["runtime", "provider"]) === "chatgpt" &&
    getAtPath(draft, ["runtime", "chatgptAccountId"]) !== accountId
    ? deleteAtPath(selected, ["runtime", "model"])
    : selected;
}

/** Persist the account owning the selected catalog even when it came from auth.current. */
export function selectChatGptModel(
  draft: JsonObject,
  model: string,
  accountId: string,
): JsonObject {
  const withProvider = setAtPath(draft, ["runtime", "provider"], "chatgpt");
  const withAccount = setAtPath(withProvider, ["runtime", "chatgptAccountId"], accountId);
  return setAtPath(withAccount, ["runtime", "model"], model);
}
