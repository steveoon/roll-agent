import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryItem } from "./state.ts";
import type { TranscriptHistoryReader, TranscriptHistorySource } from "./transcript-history.ts";

interface HistoryState {
  readonly reader?: TranscriptHistoryReader;
  readonly items: readonly HistoryItem[];
  readonly beforeSequence?: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openHistory(threadId: string, source?: TranscriptHistorySource): HistoryState {
  const empty = { items: [], hasMore: false, loading: false };
  if (source === undefined) return empty;
  let reader: TranscriptHistoryReader;
  try {
    reader = source(threadId);
  } catch (error) {
    return { ...empty, error: `历史读取失败，请重新打开会话：${failure(error)}` };
  }
  try {
    const page = reader.read();
    return {
      reader,
      items: page.items,
      hasMore: page.nextBeforeSequence !== undefined,
      loading: false,
      ...(page.nextBeforeSequence === undefined ? {} : { beforeSequence: page.nextBeforeSequence }),
    };
  } catch (error) {
    return { ...empty, reader, hasMore: true, error: failure(error) };
  }
}

export function useTranscriptHistory(threadId: string, source?: TranscriptHistorySource) {
  const [state, setState] = useState(() => openHistory(threadId, source));
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadOlder = useCallback(() => {
    if (busy.current || !state.hasMore || state.reader === undefined) return;
    busy.current = true;
    setState((current) => {
      const { error: _error, ...rest } = current;
      return { ...rest, loading: true };
    });
    const reader = state.reader;
    Promise.resolve()
      .then(() => reader.read(state.beforeSequence))
      .then(
        (page) => {
          if (!mounted.current) return;
          setState((current) => {
            const existing = new Set(current.items.map((item) => item.id));
            return {
              reader,
              items: [...page.items.filter((item) => !existing.has(item.id)), ...current.items],
              hasMore: page.nextBeforeSequence !== undefined,
              loading: false,
              ...(page.nextBeforeSequence === undefined
                ? {}
                : { beforeSequence: page.nextBeforeSequence }),
            };
          });
        },
        (error: unknown) => {
          if (mounted.current) {
            setState((current) => ({ ...current, loading: false, error: failure(error) }));
          }
        },
      )
      .finally(() => {
        busy.current = false;
      });
  }, [state.beforeSequence, state.hasMore, state.reader]);

  const notice = state.loading
    ? "正在加载更早记录…"
    : state.error !== undefined
      ? `历史加载失败：${state.error}${state.hasMore ? " · 向上滚动重试" : ""}`
      : state.hasMore
        ? "↑ 还有更早记录，向上滚动加载"
        : state.reader?.legacy
          ? "已到现存历史开头（旧版迁移，可能缺少更早记录）"
          : state.items.length > 0
            ? "已到历史开头"
            : undefined;
  return { ...state, notice, loadOlder };
}
