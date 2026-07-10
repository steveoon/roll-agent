export {
  OFFICIAL_AGENT_CATALOG,
  catalogPackageSpec,
  findCatalogEntry,
  getAgentCatalog,
} from "./catalog.ts";
export type { AgentCatalogEntry, CatalogEntryMatch, OfficialAgentShortName } from "./catalog.ts";
export { resolveAgentCatalog } from "./catalog-discovery.ts";
export type { ResolveCatalogOptions } from "./catalog-discovery.ts";
export { discoverAgent } from "./discovery.ts";
export type { DiscoveredAgent } from "./discovery.ts";
export { AgentStore } from "./store.ts";
export {
  startAgent,
  stopAgent,
  stopAgentGracefully,
  getAgentPid,
  getAgentLogPath,
  probeAgentEndpoint,
  waitForAgentReady,
} from "./process-manager.ts";
export { runAgentSetup } from "./runtime-setup.ts";
export type { AgentSetupOptions, AgentSetupResult } from "./runtime-setup.ts";
