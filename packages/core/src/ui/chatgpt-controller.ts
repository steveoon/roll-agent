import { z } from "zod/v4";
import { getChatGptAuthService } from "../auth/chatgpt/service.ts";
import {
  chatGptStatusSchema,
  chatGptModelSchema,
  chatGptLoginProgressSchema,
  chatGptRefreshResultSchema,
  chatGptLogoutResultSchema,
} from "./chatgpt-public.ts";
import type { RollUiChatGptController } from "./contracts.ts";

const accountRequestSchema = z.object({ accountId: z.string().min(1).optional() }).strict();
const loginRequestSchema = z.object({ id: z.string().min(1) }).strict();

export type ChatGptUiService = Pick<
  ReturnType<typeof getChatGptAuthService>,
  "status" | "models" | "beginLogin" | "loginStatus" | "cancelLogin" | "refresh" | "logout"
>;

/** Public schema projection strips extra fields before serializing OAuth service responses. */
export function createRollUiChatGptController(
  service: ChatGptUiService = getChatGptAuthService(),
): RollUiChatGptController {
  return {
    status: async (request) =>
      chatGptStatusSchema.parse(
        await service.status(accountRequestSchema.parse(request).accountId),
      ),
    models: async (request) =>
      z
        .array(chatGptModelSchema)
        .parse(await service.models(accountRequestSchema.parse(request).accountId)),
    login: async (request) =>
      chatGptLoginProgressSchema.parse(
        await service.beginLogin(accountRequestSchema.parse(request).accountId),
      ),
    loginStatus: (request) =>
      chatGptLoginProgressSchema.parse(service.loginStatus(loginRequestSchema.parse(request).id)),
    cancelLogin: (request) =>
      chatGptLoginProgressSchema.parse(service.cancelLogin(loginRequestSchema.parse(request).id)),
    refresh: async (request) =>
      chatGptRefreshResultSchema.parse(
        await service.refresh(accountRequestSchema.parse(request).accountId),
      ),
    logout: async (request) =>
      chatGptLogoutResultSchema.parse(
        await service.logout(accountRequestSchema.parse(request).accountId),
      ),
  };
}
