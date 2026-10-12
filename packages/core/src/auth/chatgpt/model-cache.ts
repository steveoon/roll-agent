import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { chatGptModelSchema, type ChatGptModel, type ChatGptRegistration } from "./schemas.ts";

const cacheSchema = z.object({
  identity: z.string(),
  savedAt: z.number(),
  models: z.array(chatGptModelSchema),
});
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const identity = (profile: ChatGptRegistration) =>
  createHash("sha256")
    .update(JSON.stringify([profile.id, profile.clientId, profile.subject]))
    .digest("hex");
const cachePath = (directory: string, profile: ChatGptRegistration) =>
  resolve(directory, "model-cache", `${z.string().uuid().parse(profile.id)}.json`);

/** Display-only, registration-bound cache. Live validation is still required before inference. */
export function readChatGptModelCache(
  directory: string,
  profile: ChatGptRegistration,
  now: number,
): ChatGptModel[] {
  try {
    const cached = cacheSchema.parse(
      JSON.parse(readFileSync(cachePath(directory, profile), "utf8")),
    );
    return cached.identity === identity(profile) &&
      cached.savedAt <= now &&
      now - cached.savedAt <= MAX_AGE_MS
      ? cached.models
      : [];
  } catch {
    return [];
  }
}

export function writeChatGptModelCache(
  directory: string,
  profile: ChatGptRegistration,
  models: ChatGptModel[],
  now: number,
): void {
  let temporary: string | undefined;
  try {
    const target = cachePath(directory, profile);
    mkdirSync(resolve(directory, "model-cache"), { recursive: true, mode: 0o700 });
    temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify(
        cacheSchema.parse({
          identity: identity(profile),
          savedAt: now,
          models,
        }),
      ),
      { flag: "wx", mode: 0o600 },
    );
    renameSync(temporary, target);
  } catch {
    // A display cache failure must never invalidate credentials or block a successful request.
  } finally {
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Optional cache cleanup. */
      }
    }
  }
}
