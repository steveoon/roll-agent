import type { ChildProcess } from "node:child_process";
import type { BashStreamName } from "../exec.ts";
import type { ShellProfile } from "../profile.ts";
import type { ShellPipeCapability } from "../shell-pipe.ts";
import type { HeadTailBuffer } from "./head-tail-buffer.ts";

export type SessionDeltaHandler = (stream: BashStreamName, delta: string) => void;

export const SESSION_STATES = {
  running: "running",
  draining: "draining",
  stopping: "stopping",
  completed: "completed",
  cleanupFailed: "cleanup-failed",
} as const;

export type SessionState = (typeof SESSION_STATES)[keyof typeof SESSION_STATES];
export type TerminalSessionState =
  | typeof SESSION_STATES.completed
  | typeof SESSION_STATES.cleanupFailed;

export const SESSION_TERMINATION_CAUSES = {
  interrupt: "interrupt",
  terminate: "terminate",
} as const;

export type SessionTerminationCause =
  (typeof SESSION_TERMINATION_CAUSES)[keyof typeof SESSION_TERMINATION_CAUSES];

export interface ManagedSession {
  readonly id: number;
  readonly command: string;
  readonly workdir: string;
  readonly profile: ShellProfile;
  readonly child: ChildProcess;
  readonly buffer: HeadTailBuffer;
  readonly startedAt: number;
  state: SessionState;
  exitCode: number | undefined;
  exitObserved: boolean;
  closeObserved: boolean;
  completedAt: number | undefined;
  terminationCause: SessionTerminationCause | undefined;
  cleanupError: string | undefined;
  lastUsedAt: number;
  pipeSegments?: readonly number[] | undefined;
  pipeCapability?: ShellPipeCapability | undefined;
  dumpPath?: string | undefined;
  beginPoll(onDelta?: SessionDeltaHandler): boolean;
  endPoll(): void;
  markStopping(cause: SessionTerminationCause): void;
  markCompleted(): void;
  markCleanupFailed(message: string): void;
  waitExit(): Promise<void>;
  waitClose(): Promise<void>;
  waitSettled(): Promise<void>;
}

export type SessionPollResult =
  | {
      readonly kind: "exited";
      readonly output: string;
      readonly omitted: number;
      readonly wallTimeMs: number;
      readonly exitCode: number;
      readonly state: TerminalSessionState;
      readonly terminationCause?: SessionTerminationCause;
      readonly cleanupError?: string;
      readonly pipeSegments?: readonly number[];
      readonly pipeCapability?: ShellPipeCapability;
      readonly dumpPath?: string;
    }
  | {
      readonly kind: "running";
      readonly output: string;
      readonly omitted: number;
      readonly wallTimeMs: number;
      readonly sessionId: number;
    };

export interface SpawnSessionInput {
  readonly id: number;
  readonly command: string;
  readonly workdir: string;
  readonly profile: ShellProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly bufferCapacity: number;
  readonly onDelta?: SessionDeltaHandler;
}

export interface SessionPollOptions {
  readonly abortSignal?: AbortSignal;
  readonly onDelta?: SessionDeltaHandler;
}

export interface SessionSummary {
  readonly sessionId: number;
  readonly commandPreview: string;
  readonly workdir: string;
  readonly state: SessionState;
  readonly startedAt: number;
  readonly lastUsedAt: number;
  readonly wallTimeMs: number;
  readonly exitCode?: number;
  readonly terminationCause?: SessionTerminationCause;
  readonly cleanupError?: string;
}

export function isTerminalSessionState(state: SessionState): state is TerminalSessionState {
  return state === SESSION_STATES.completed || state === SESSION_STATES.cleanupFailed;
}
