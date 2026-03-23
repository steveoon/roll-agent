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
