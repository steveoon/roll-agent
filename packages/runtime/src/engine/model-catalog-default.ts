import { ModelCatalog } from "./model-catalog.ts";
import { MODEL_CATALOG_SNAPSHOT } from "./model-catalog-snapshot.ts";

export function createDefaultModelCatalog(cachePath?: string): ModelCatalog {
  return new ModelCatalog({
    snapshot: MODEL_CATALOG_SNAPSHOT,
    ...(cachePath !== undefined ? { cachePath } : {}),
  });
}
