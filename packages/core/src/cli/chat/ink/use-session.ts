import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AgentSession, SessionAttachment, SessionEvent } from "@roll-agent/runtime";
import {
  chatReducer,
  createInitialState,
  type ChatUiState,
  type ConfirmDecision,
  type HistoryItem,
  type PendingUserInput,
} from "./state.ts";
import type { ThinkingLevel } from "../../../llm/providers.ts";
import type { ChatThinkingDisplay } from "../../../config/schema.ts";
import { log } from "../../utils/output.ts";
import { formatDebugEvent } from "../../utils/debug-format.ts";

export interface UseSessionOptions {
  readonly model: string;
  readonly contextWindow: number | undefined;
  readonly initialHistory?: readonly HistoryItem[];
  readonly initialThinkingLevel?: ThinkingLevel;
  readonly initialThinkingDisplay?: ChatThinkingDisplay;
  readonly onThinkingChange?: (level: ThinkingLevel) => void;
}

export interface UseSessionSubmitAttachment extends SessionAttachment {
  readonly name: string;
}

export interface UseSessionResult {
  readonly state: ChatUiState;
  readonly submit: (text: string, attachments?: readonly UseSessionSubmitAttachment[]) => void;
  readonly compact: () => void;
  readonly cancel: () => void;
  readonly resolveConfirm: (decision: ConfirmDecision) => void;
  readonly resolveUserInput: (
    requestId: PendingUserInput["requestId"],
    result: UserInputResult,
  ) => void;
  readonly setDraft: (value: string) => void;
  readonly setThinking: (level: ThinkingLevel) => void;
  readonly setThinkingDisplay: (value: ChatThinkingDisplay) => void;
  readonly setAutoMode: (value: boolean) => void;
  readonly toggleAutoMode: () => void;
  readonly commitHistory: (item: HistoryItem) => void;
}

const STREAM_FLUSH_MS = 32;

type StreamDeltaEvent = Extract<SessionEvent, { type: "text-delta" | "reasoning-delta" }>;
type UserInputResult = Parameters<AgentSession["resolveUserInput"]>[1];

interface PendingUserInputDecision {
  readonly requestId: PendingUserInput["requestId"];
  readonly resolve: (result: UserInputResult) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSession(session: AgentSession, options: UseSessionOptions): UseSessionResult {
  const [state, dispatch] = useReducer(
    chatReducer,
    createInitialState(options.model, options.contextWindow, {
      ...(options.initialHistory ? { history: options.initialHistory } : {}),
      ...(options.initialThinkingLevel ? { thinkingLevel: options.initialThinkingLevel } : {}),
      ...(options.initialThinkingDisplay
        ? { thinkingDisplay: options.initialThinkingDisplay }
        : {}),
    }),
  );
  const onThinkingChange = options.onThinkingChange;
  const decisionRef = useRef<((decision: ConfirmDecision) => void) | null>(null);
  const userInputDecisionRef = useRef<PendingUserInputDecision | null>(null);
  const autoModeRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    session.setUserInputAvailable?.(true);
    return () => {
      userInputDecisionRef.current?.resolve({
        status: "cancelled",
        reason: "用户输入界面已关闭",
      });
      userInputDecisionRef.current = null;
      session.setUserInputAvailable?.(false);
    };
  }, [session]);

  const drive = useCallback(
    async (iterable: AsyncIterable<SessionEvent>) => {
      let pendingDelta: StreamDeltaEvent | undefined;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flushPending = () => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (pendingDelta !== undefined) {
          const event = pendingDelta;
          pendingDelta = undefined;
          dispatch({
            type: "session-event",
            id: randomUUID(),
            event,
          });
        }
      };
      const bufferDelta = (event: StreamDeltaEvent): void => {
        if (pendingDelta === undefined) {
          pendingDelta = event;
        } else if (pendingDelta.type === "text-delta" && event.type === "text-delta") {
          pendingDelta = { type: "text-delta", delta: pendingDelta.delta + event.delta };
        } else if (
          pendingDelta.type === "reasoning-delta" &&
          event.type === "reasoning-delta" &&
          pendingDelta.reasoningId === event.reasoningId
        ) {
          pendingDelta = {
            type: "reasoning-delta",
            reasoningId: event.reasoningId,
            delta: pendingDelta.delta + event.delta,
          };
        } else {
          flushPending();
          pendingDelta = event;
        }
        if (flushTimer === undefined) {
          flushTimer = setTimeout(flushPending, STREAM_FLUSH_MS);
        }
      };
      try {
        for await (const event of iterable) {
          if (event.type === "debug") {
            log.debug(formatDebugEvent(event));
            continue;
          }
          if (event.type === "text-delta" || event.type === "reasoning-delta") {
            bufferDelta(event);
            continue;
          }
          flushPending();
          if (event.type === "confirmation-required") {
            if (autoModeRef.current) {
              session.approve(event.approvalId);
              continue;
            }
            const decisionPromise = new Promise<ConfirmDecision>((resolve) => {
              decisionRef.current = resolve;
            });
            dispatch({ type: "session-event", id: randomUUID(), event });
            const decision = await decisionPromise;
            decisionRef.current = null;
            if (decision.approved) {
              session.approve(event.approvalId, decision.scope);
            } else {
              session.reject(event.approvalId, "用户取消");
            }
            dispatch({ type: "confirm-resolved" });
            continue;
          }
          if (event.type === "user-input-required") {
            dispatch({ type: "session-event", id: randomUUID(), event });
            const result = await new Promise<UserInputResult>((resolve) => {
              let settled = false;
              const expiresAt = Date.parse(event.expiresAt);
              const remainingMs = Number.isFinite(expiresAt)
                ? Math.max(0, expiresAt - Date.now())
                : 0;
              const expiryTimer = setTimeout(() => {
                settle({ status: "cancelled", reason: "用户输入请求已超时" });
              }, remainingMs);
              const settle = (candidate: UserInputResult): void => {
                if (settled) {
                  return;
                }
                settled = true;
                clearTimeout(expiryTimer);
                resolve(candidate);
              };
              userInputDecisionRef.current = {
                requestId: event.requestId,
                resolve: settle,
              };
            });
            if (userInputDecisionRef.current?.requestId === event.requestId) {
              userInputDecisionRef.current = null;
            }
            if (result.status === "submitted") {
              session.resolveUserInput?.(event.requestId, result);
            } else {
              session.cancelUserInput?.(event.requestId, result.reason);
            }
            dispatch({ type: "user-input-resolved", requestId: event.requestId });
            continue;
          }
          dispatch({ type: "session-event", id: randomUUID(), event });
        }
      } catch (error) {
        flushPending();
        dispatch({
          type: "session-event",
          id: randomUUID(),
          event: { type: "error", stage: "execute", message: errorMessage(error) },
        });
      } finally {
        flushPending();
        dispatch({ type: "turn-end" });
        busyRef.current = false;
      }
    },
    [session],
  );

  const submit = useCallback(
    (text: string, attachments?: readonly UseSessionSubmitAttachment[]) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      dispatch({
        type: "submit-user",
        id: randomUUID(),
        text,
        ...(attachments !== undefined && attachments.length > 0
          ? { attachmentLabels: attachments.map((attachment) => attachment.name) }
          : {}),
      });
      const input =
        attachments !== undefined && attachments.length > 0
          ? {
              text,
              attachments: attachments.map((attachment) => ({
                data: attachment.data,
                mediaType: attachment.mediaType,
              })),
            }
          : text;
      drive(session.send(input)).catch(() => undefined);
    },
    [drive, session],
  );

  const compact = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    dispatch({ type: "start-compaction" });
    drive(session.compact("manual")).catch(() => undefined);
  }, [drive, session]);

  const cancel = useCallback(() => {
    if (!busyRef.current) {
      return;
    }
    if (session.cancel()) {
      dispatch({ type: "cancel-requested" });
    }
  }, [session]);

  const resolveConfirm = useCallback((decision: ConfirmDecision) => {
    decisionRef.current?.(decision);
  }, []);

  const resolveUserInput = useCallback(
    (requestId: PendingUserInput["requestId"], result: UserInputResult) => {
      const pending = userInputDecisionRef.current;
      if (pending?.requestId === requestId) {
        pending.resolve(result);
      }
    },
    [],
  );

  const setDraft = useCallback((value: string) => {
    dispatch({ type: "set-draft", value });
  }, []);

  const setThinking = useCallback(
    (level: ThinkingLevel) => {
      dispatch({ type: "set-thinking", level });
      onThinkingChange?.(level);
    },
    [onThinkingChange],
  );

  const setThinkingDisplay = useCallback((value: ChatThinkingDisplay) => {
    dispatch({ type: "set-thinking-display", value });
  }, []);

  const setAutoMode = useCallback((value: boolean) => {
    autoModeRef.current = value;
    dispatch({ type: "set-auto", value });
    if (value) {
      decisionRef.current?.({ approved: true });
    }
  }, []);

  const toggleAutoMode = useCallback(() => {
    setAutoMode(!autoModeRef.current);
  }, [setAutoMode]);

  const commitHistory = useCallback((item: HistoryItem) => {
    dispatch({ type: "commit-history", item });
  }, []);

  return {
    state,
    submit,
    compact,
    cancel,
    resolveConfirm,
    resolveUserInput,
    setDraft,
    setThinking,
    setThinkingDisplay,
    setAutoMode,
    toggleAutoMode,
    commitHistory,
  };
}
