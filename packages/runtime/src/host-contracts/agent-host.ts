import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { SkillLibrary } from "../skills/contracts.ts";
import type { AgentToolSource } from "../tool-bridge/build-tools.ts";
import type {
  AgentInstallToolCatalogEntry,
  AgentInstallToolOutcome,
} from "../tool-bridge/agent-install-tool.ts";

export interface AgentHostOperation {
  readonly model: LanguageModelV4;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly signal: AbortSignal;
}

export interface AgentHostSnapshot {
  readonly sources: readonly AgentToolSource[];
  readonly skillLibrary?: SkillLibrary;
  readonly catalog?: readonly AgentInstallToolCatalogEntry[];
}

export interface AgentHostRefresh {
  readonly source: AgentToolSource;
  readonly skillLibrary?: SkillLibrary;
}

export interface AgentHostInstallResult {
  /** An installation fact. A subsequent discovery failure must not erase success. */
  readonly outcome: AgentInstallToolOutcome;
}

/**
 * One engine owns one host. The host releases only resources it acquired.
 * Cancellation requests settlement; implementations must not abandon late side effects.
 */
export interface AgentHost {
  prepare(input: AgentHostOperation): Promise<AgentHostSnapshot>;
  refresh(agentName: string, input: AgentHostOperation): Promise<AgentHostRefresh>;
  install?(
    shortName: string,
    report: (line: string) => void,
    signal: AbortSignal,
  ): Promise<AgentHostInstallResult>;
  /**
   * Synchronous memory update; must not open connections or perform external I/O.
   * Validate before writing: a thrown error must leave the previous Sampling state intact.
   */
  updateSampling(
    model: LanguageModelV4,
    providerOptions: SharedV4ProviderOptions | undefined,
  ): void;
  /** Idempotent cleanup, rejecting with all cleanup failures instead of hiding them. */
  dispose(): Promise<void>;
}
