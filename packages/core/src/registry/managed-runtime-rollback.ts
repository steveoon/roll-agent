import type {
  AgentLifecycleLock,
  ManagedAgentRuntimeIdentity,
  stopAgentGracefully,
} from "./process-manager.ts";

export interface ManagedAgentStartRollbackInput {
  readonly agentName: string;
  readonly dataDir: string;
  readonly expectedIdentity: ManagedAgentRuntimeIdentity | undefined;
  readonly lifecycleLock: AgentLifecycleLock;
  readonly cause: unknown;
  readonly rollbackFailureMessage: string;
  readonly stopGracefully: typeof stopAgentGracefully;
}

/**
 * Re-throws a managed runtime startup failure after safely rolling back the process created by the
 * failed attempt.
 *
 * The rollback is intentionally identity-bound. If startup did not yield a verified runtime
 * identity, this helper will not issue an unscoped stop that could terminate a concurrent
 * replacement process.
 */
export async function rollbackStartedManagedAgentOrThrow(
  input: ManagedAgentStartRollbackInput,
): Promise<never> {
  if (input.expectedIdentity === undefined) {
    throw input.cause;
  }

  try {
    await input.stopGracefully(input.dataDir, input.agentName, {
      expectedIdentity: input.expectedIdentity,
      lifecycleLock: input.lifecycleLock,
    });
  } catch (cleanupError) {
    throw new AggregateError([input.cause, cleanupError], input.rollbackFailureMessage);
  }

  throw input.cause;
}
