import type { ChildProcess } from "node:child_process";
import type { BashStreamName } from "../exec.ts";
import type { ShellProfile } from "../profile.ts";
import type { HeadTailBuffer } from "./head-tail-buffer.ts";

export type SessionDeltaHandler = (stream: BashStreamName, delta: string) => void;

export interface ManagedSession {
  readonly id: number;
  readonly profile: ShellProfile;
  readonly child: ChildProcess;
  readonly buffer: HeadTailBuffer;
  readonly startedAt: number;
  exitCode: number | undefined;
  lastUsedAt: number;
  onDelta: SessionDeltaHandler | undefined;
  waitExit(): Promise<void>;
  waitClose(): Promise<void>;
}

export type SessionPollResult =
  | {
      readonly kind: "exited";
      readonly output: string;
      readonly omitted: number;
      readonly wallTimeMs: number;
      readonly exitCode: number;
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
