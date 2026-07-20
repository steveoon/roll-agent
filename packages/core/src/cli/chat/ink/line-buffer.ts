import { displayWidth } from "./display-width.ts";

export interface LineBufferState {
  readonly value: string;
  readonly cursor: number;
  readonly goalColumn: number | undefined;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function lineStartAt(value: string, offset: number): number {
  if (offset === 0) {
    return 0;
  }
  return value.lastIndexOf("\n", offset - 1) + 1;
}

function lineBoundsAt(value: string, offset: number): { start: number; end: number } {
  const start = lineStartAt(value, offset);
  const newlineIndex = value.indexOf("\n", offset);
  return { start, end: newlineIndex === -1 ? value.length : newlineIndex };
}

function firstGrapheme(text: string): string | undefined {
  const [first] = graphemeSegmenter.segment(text);
  return first?.segment;
}

function nextGraphemeBoundary(value: string, offset: number): number {
  if (offset >= value.length) {
    return value.length;
  }
  const cluster = firstGrapheme(value.slice(offset));
  return cluster === undefined ? value.length : offset + cluster.length;
}

function previousGraphemeBoundary(value: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  const start = lineStartAt(value, offset);
  if (offset === start) {
    return start - 1;
  }
  let boundary = start;
  for (const segment of graphemeSegmenter.segment(value.slice(start, offset))) {
    boundary = start + segment.index;
  }
  return boundary;
}

type CursorAffinity = "backward" | "forward";

function snapToGraphemeBoundary(value: string, offset: number, affinity: CursorAffinity): number {
  const clamped = Math.max(0, Math.min(offset, value.length));
  if (clamped === 0) {
    return 0;
  }
  if (clamped === value.length) {
    return value.length;
  }
  const segment = graphemeSegmenter.segment(value).containing(clamped);
  if (segment === undefined || segment.index === clamped) {
    return clamped;
  }
  return affinity === "backward" ? segment.index : segment.index + segment.segment.length;
}

function replaceRange(
  state: LineBufferState,
  start: number,
  end: number,
  replacement = "",
): LineBufferState {
  const value = state.value.slice(0, start) + replacement + state.value.slice(end);
  // A splice can join both sides into one cluster, so prefer the first legal boundary after it.
  const cursor = snapToGraphemeBoundary(value, start + replacement.length, "forward");
  return { value, cursor, goalColumn: undefined };
}

function isWordLikeSegment(segment: Intl.SegmentData): boolean {
  return segment.isWordLike === true;
}

function previousWordBoundary(value: string, offset: number): number {
  let boundary = 0;
  for (const segment of wordSegmenter.segment(value.slice(0, offset))) {
    if (isWordLikeSegment(segment)) {
      boundary = segment.index;
    }
  }
  return boundary;
}

function nextWordBoundary(value: string, offset: number): number {
  for (const segment of wordSegmenter.segment(value.slice(offset))) {
    if (isWordLikeSegment(segment)) {
      return offset + segment.index + segment.segment.length;
    }
  }
  return value.length;
}

function columnAt(value: string, offset: number): number {
  return displayWidth(value.slice(lineStartAt(value, offset), offset));
}

function offsetForColumn(value: string, start: number, end: number, column: number): number {
  let offset = start;
  let width = 0;
  for (const segment of graphemeSegmenter.segment(value.slice(start, end))) {
    const segmentWidth = displayWidth(segment.segment);
    if (width + segmentWidth > column) {
      break;
    }
    width += segmentWidth;
    offset = start + segment.index + segment.segment.length;
  }
  return offset;
}

interface VisualLineBounds {
  readonly start: number;
  readonly end: number;
  readonly softWrap: boolean;
}

function visualLineBounds(value: string, columns: number, cursor: number): VisualLineBounds[] {
  const width = Math.max(1, Math.floor(columns));
  const rows: VisualLineBounds[] = [];
  let logicalStart = 0;
  while (logicalStart <= value.length) {
    const newlineIndex = value.indexOf("\n", logicalStart);
    const logicalEnd = newlineIndex === -1 ? value.length : newlineIndex;
    let rowStart = logicalStart;
    let rowWidth = 0;
    for (const segment of graphemeSegmenter.segment(value.slice(logicalStart, logicalEnd))) {
      const offset = logicalStart + segment.index;
      const segmentWidth = displayWidth(segment.segment);
      if (rowWidth > 0 && rowWidth + segmentWidth > width) {
        rows.push({ start: rowStart, end: offset, softWrap: true });
        rowStart = offset;
        rowWidth = 0;
      }
      rowWidth += segmentWidth;
    }
    const cursorWraps = cursor === logicalEnd && rowWidth >= width;
    rows.push({ start: rowStart, end: logicalEnd, softWrap: cursorWraps });
    if (cursorWraps) {
      rows.push({ start: logicalEnd, end: logicalEnd, softWrap: false });
    }
    if (newlineIndex === -1) {
      break;
    }
    logicalStart = newlineIndex + 1;
  }
  return rows;
}

function visualLineIndexAt(rows: readonly VisualLineBounds[], cursor: number): number {
  for (const [index, row] of rows.entries()) {
    if (cursor < row.end || (cursor === row.end && !row.softWrap)) {
      return index;
    }
  }
  return Math.max(0, rows.length - 1);
}

function moveVisualVertical(
  state: LineBufferState,
  direction: -1 | 1,
  columns: number,
): LineBufferState {
  const rows = visualLineBounds(state.value, columns, state.cursor);
  const currentIndex = visualLineIndexAt(rows, state.cursor);
  const current = rows[currentIndex];
  const target = rows[currentIndex + direction];
  if (current === undefined || target === undefined) {
    return state;
  }
  const goal = state.goalColumn ?? displayWidth(state.value.slice(current.start, state.cursor));
  let cursor = offsetForColumn(state.value, target.start, target.end, goal);
  if (target.softWrap && cursor === target.end && target.start < target.end) {
    cursor = previousGraphemeBoundary(state.value, target.end);
  }
  return { value: state.value, cursor, goalColumn: goal };
}

function clearGoal(state: LineBufferState): LineBufferState {
  if (state.goalColumn === undefined) {
    return state;
  }
  return { value: state.value, cursor: state.cursor, goalColumn: undefined };
}

export function createLineBuffer(value: string, cursor?: number): LineBufferState {
  const clamped = Math.max(0, Math.min(cursor ?? value.length, value.length));
  return {
    value,
    cursor: snapToGraphemeBoundary(value, clamped, "backward"),
    goalColumn: undefined,
  };
}

export function graphemeAt(value: string, offset: number): string {
  if (offset < 0 || offset >= value.length) {
    return "";
  }
  return firstGrapheme(value.slice(offset)) ?? "";
}

export function insertText(state: LineBufferState, text: string): LineBufferState {
  if (text.length === 0) {
    return clearGoal(state);
  }
  return replaceRange(state, state.cursor, state.cursor, text);
}

export function deleteBackward(state: LineBufferState): LineBufferState {
  if (state.cursor === 0) {
    return clearGoal(state);
  }
  const boundary = previousGraphemeBoundary(state.value, state.cursor);
  return replaceRange(state, boundary, state.cursor);
}

export function deleteForward(state: LineBufferState): LineBufferState {
  if (state.cursor >= state.value.length) {
    return clearGoal(state);
  }
  const boundary = nextGraphemeBoundary(state.value, state.cursor);
  return replaceRange(state, state.cursor, boundary);
}

export function deleteWordBackward(state: LineBufferState): LineBufferState {
  if (state.cursor === 0) {
    return clearGoal(state);
  }
  const boundary = previousWordBoundary(state.value, state.cursor);
  return replaceRange(state, boundary, state.cursor);
}

export function killToLineStart(state: LineBufferState): LineBufferState {
  const { start } = lineBoundsAt(state.value, state.cursor);
  if (start === state.cursor) {
    return clearGoal(state);
  }
  return replaceRange(state, start, state.cursor);
}

export function killToLineEnd(state: LineBufferState): LineBufferState {
  const { end } = lineBoundsAt(state.value, state.cursor);
  if (state.cursor === end) {
    if (end === state.value.length) {
      return clearGoal(state);
    }
    return replaceRange(state, state.cursor, end + 1);
  }
  return replaceRange(state, state.cursor, end);
}

export function moveLeft(state: LineBufferState): LineBufferState {
  if (state.cursor === 0) {
    return clearGoal(state);
  }
  return {
    value: state.value,
    cursor: previousGraphemeBoundary(state.value, state.cursor),
    goalColumn: undefined,
  };
}

export function moveRight(state: LineBufferState): LineBufferState {
  if (state.cursor >= state.value.length) {
    return clearGoal(state);
  }
  return {
    value: state.value,
    cursor: nextGraphemeBoundary(state.value, state.cursor),
    goalColumn: undefined,
  };
}

export function moveWordLeft(state: LineBufferState): LineBufferState {
  return {
    value: state.value,
    cursor: previousWordBoundary(state.value, state.cursor),
    goalColumn: undefined,
  };
}

export function moveWordRight(state: LineBufferState): LineBufferState {
  return {
    value: state.value,
    cursor: nextWordBoundary(state.value, state.cursor),
    goalColumn: undefined,
  };
}

export function moveToLineStart(state: LineBufferState): LineBufferState {
  return {
    value: state.value,
    cursor: lineBoundsAt(state.value, state.cursor).start,
    goalColumn: undefined,
  };
}

export function moveToLineEnd(state: LineBufferState): LineBufferState {
  return {
    value: state.value,
    cursor: lineBoundsAt(state.value, state.cursor).end,
    goalColumn: undefined,
  };
}

export function moveUp(state: LineBufferState): LineBufferState {
  const { start } = lineBoundsAt(state.value, state.cursor);
  if (start === 0) {
    return state;
  }
  const goal = state.goalColumn ?? columnAt(state.value, state.cursor);
  const previous = lineBoundsAt(state.value, start - 1);
  return {
    value: state.value,
    cursor: offsetForColumn(state.value, previous.start, previous.end, goal),
    goalColumn: goal,
  };
}

export function moveDown(state: LineBufferState): LineBufferState {
  const { end } = lineBoundsAt(state.value, state.cursor);
  if (end === state.value.length) {
    return state;
  }
  const goal = state.goalColumn ?? columnAt(state.value, state.cursor);
  const next = lineBoundsAt(state.value, end + 1);
  return {
    value: state.value,
    cursor: offsetForColumn(state.value, next.start, next.end, goal),
    goalColumn: goal,
  };
}

export function moveVisualUp(state: LineBufferState, columns: number): LineBufferState {
  return moveVisualVertical(state, -1, columns);
}

export function moveVisualDown(state: LineBufferState, columns: number): LineBufferState {
  return moveVisualVertical(state, 1, columns);
}
