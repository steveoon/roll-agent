import type { ModelCatalog } from "@roll-agent/runtime";
import type { RuntimeModule } from "./engine-factory.ts";
import type { ChatGptModels } from "./chatgpt-resolution.ts";

/** An account-local overlay. Subscription limits never enter the shared cache. */
export function createChatGptCatalog(
  runtime: RuntimeModule,
  apiCatalog: ModelCatalog,
  getModels: () => ChatGptModels,
): ModelCatalog {
  class ChatGptCatalog extends runtime.ModelCatalog {
    override lookup(provider: string, modelName: string): number | undefined {
      return provider === "chatgpt"
        ? getModels().find(({ slug }) => slug === modelName)?.contextWindow
        : apiCatalog.lookup(provider, modelName);
    }
    override refreshIfStale(signal?: AbortSignal) {
      return apiCatalog.refreshIfStale(signal);
    }
  }
  return new ChatGptCatalog({ snapshot: apiCatalog.data() });
}
