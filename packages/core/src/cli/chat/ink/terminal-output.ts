import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";

const WRITE_TRACE_PATH = process.env["ROLL_CHAT_WRITE_TRACE"];

function trace(direction: string, value: string): void {
  if (WRITE_TRACE_PATH !== undefined) {
    appendFileSync(WRITE_TRACE_PATH, `${direction} ${JSON.stringify(value)}\n`);
  }
}

const ERASE_SCROLLBACK = "\u001B[3J";
const CLEAR_VIEWPORT = "\u001B[2J\u001B[H";
const BEGIN_SYNCHRONIZED_UPDATE = "\u001B[?2026h";
const END_SYNCHRONIZED_UPDATE = "\u001B[?2026l";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const RESIZE_SETTLE_MS = 16;
const SYNC_CLOSE_HOLD_MS = 100;
const CLEANUP_SEQUENCES = [
  "\u001B[?1049l",
  "\u001B[?25h",
  "\u001B[?2004l",
  "\u001B[?1000l",
  "\u001B[?1002l",
  "\u001B[?1003l",
  "\u001B[?1015l",
  "\u001B[?1006l",
  "\u001B[<u",
] as const;
const ESCAPE = String.fromCharCode(27);
const CSI_BODY = "\\[[0-?]*[ -/]*[@-~]";
const CSI_SEQUENCE = new RegExp(`${ESCAPE}${CSI_BODY}`, "g");
const TRAILING_CSI_SEQUENCES = new RegExp(`(?:${ESCAPE}${CSI_BODY})+$`, "g");

export const CHAT_CURSOR_REFRESH_EVENT = "roll:chat-cursor-refresh";

function isCleanupOnlyWrite(value: string): boolean {
  let remaining = value;
  for (const sequence of CLEANUP_SEQUENCES) {
    remaining = remaining.replaceAll(sequence, "");
  }
  return remaining.length === 0;
}

function hasVisibleContent(value: string): boolean {
  return value.replace(CSI_SEQUENCE, "").replace(/[\r\n\t]/g, "").length > 0;
}

function endsAtNextLine(value: string): boolean {
  return /[\r\n]$/.test(value.replace(TRAILING_CSI_SEQUENCES, ""));
}

function wrapCursorRewrite(value: string, alreadySynchronized: boolean): string {
  if (
    alreadySynchronized ||
    !value.includes(HIDE_CURSOR) ||
    !value.includes(SHOW_CURSOR) ||
    value.includes(BEGIN_SYNCHRONIZED_UPDATE)
  ) {
    return value;
  }
  return BEGIN_SYNCHRONIZED_UPDATE + value + END_SYNCHRONIZED_UPDATE;
}

export interface ChatTerminalOutput {
  readonly stdout: NodeJS.WriteStream;
  dispose(): void;
}

class ManagedChatOutput extends Writable {
  private readonly source: NodeJS.WriteStream;
  private renderedColumns: number;
  private nextColumnsRead: number | undefined;
  private suppressNextResizeClear = false;
  private suppressVisualWrites = false;
  private resizeSynchronizationOpen = false;
  private resizeFrameNeedsCursorLineAdvance = false;
  private resizeTimer: NodeJS.Timeout | undefined;
  private cursorRefreshQueued = false;
  private pendingCursorFrame: string | undefined;
  private spanSawHide = false;
  private spanSawShow = false;
  private withheldSyncClose = false;
  private withheldSyncTimer: NodeJS.Timeout | undefined;
  private readonly handleSourceResize = (): void => {
    if (this.resizeTimer !== undefined) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      const actualColumns = this.source.columns;
      const resizeListeners = this.listeners("resize");
      const rendererResizeListener = resizeListeners[0];
      const probeColumns = Math.max(1, Math.min(this.renderedColumns, actualColumns) - 1);
      if (rendererResizeListener !== undefined && probeColumns < this.renderedColumns) {
        // Update React's width/height state before asking Ink for the replacement frame. Ink
        // registers its renderer listener first; component hooks follow it. Writes caused by
        // those state updates are intentionally held back until the one committed redraw below.
        this.suppressVisualWrites = true;
        try {
          for (const listener of resizeListeners.slice(1)) {
            listener.call(this);
          }
        } finally {
          this.suppressVisualWrites = false;
        }

        // Ink installs its renderer listener before component hooks. Give that listener one
        // synthetic shrink read so it discards the prior log-update frame, while every layout
        // read still observes the real settled dimensions. A second renderer-only notification
        // synchronizes Ink's remembered width without scheduling another component render.
        // Start the synchronized update before clearing so terminals keep the previous complete
        // frame visible until Ink commits its replacement frame.
        this.source.write(BEGIN_SYNCHRONIZED_UPDATE + CLEAR_VIEWPORT);
        this.resizeSynchronizationOpen = true;
        this.nextColumnsRead = probeColumns;
        this.suppressNextResizeClear = true;
        try {
          rendererResizeListener();
        } finally {
          this.nextColumnsRead = undefined;
          this.suppressNextResizeClear = false;
        }
        this.suppressVisualWrites = true;
        try {
          rendererResizeListener();
        } finally {
          this.suppressVisualWrites = false;
        }
      } else {
        this.emit("resize");
      }
      this.renderedColumns = actualColumns;
    }, RESIZE_SETTLE_MS);
  };

  constructor(source: NodeJS.WriteStream) {
    super({ decodeStrings: false });
    this.source = source;
    this.renderedColumns = source.columns;
    source.on("resize", this.handleSourceResize);
  }

  get columns(): number {
    if (this.nextColumnsRead !== undefined) {
      const columns = this.nextColumnsRead;
      this.nextColumnsRead = undefined;
      return columns;
    }
    return this.source.columns;
  }

  get rows(): number {
    return this.source.rows;
  }

  get isTTY(): true {
    return true;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const sanitized = (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk).replaceAll(
      ERASE_SCROLLBACK,
      "",
    );
    trace("IN ", sanitized);
    if (this.suppressNextResizeClear) {
      // Ink's shrink branch first asks log-update to erase the old frame. We already reset the
      // physical viewport above, so replaying those cursor-relative erase commands from row 1
      // would move the cursor away from home and duplicate the top of the next full frame.
      // Suppress exactly that first synchronous write; the immediately following render remains.
      this.suppressNextResizeClear = false;
      callback();
      return;
    }
    if (
      (this.resizeTimer !== undefined || this.suppressVisualWrites) &&
      !isCleanupOnlyWrite(sanitized)
    ) {
      // The physical terminal has already reflowed, but Ink still holds the previous Yoga frame.
      // Freeze visual writes until the trailing resize commit rebuilds one current full frame. A
      // useCursor frame contains show-cursor as well as visible content, so only a write composed
      // entirely of teardown sequences may bypass suppression.
      callback();
      return;
    }
    try {
      const arriving = sanitized;
      if (arriving.includes(BEGIN_SYNCHRONIZED_UPDATE)) {
        // Ink can write BEGIN, the redraw and the cursor suffix as three separate chunks. Track
        // the protocol from BEGIN so a follow-up fixed-viewport redraw gets the same cursor fix.
        this.resizeSynchronizationOpen = true;
        this.resizeFrameNeedsCursorLineAdvance = false;
        this.spanSawHide = false;
        this.spanSawShow = false;
      }
      const outgoing = this.assembleOutgoingWrite(arriving);
      if (outgoing === undefined) {
        callback();
        return;
      }
      // A proxy-level backpressure queue would decide whether a frame is stale only when it later
      // drains, after the resize suppression flag may already be gone. Let the real stdout own
      // buffering and keep this adapter's classification synchronous with Ink's write call.
      this.spanSawHide ||= outgoing.includes(HIDE_CURSOR);
      this.spanSawShow ||= outgoing.includes(SHOW_CURSOR);
      const payload = this.applySyncCloseHold(outgoing);
      const cursorLineAdvance =
        this.resizeSynchronizationOpen &&
        this.resizeFrameNeedsCursorLineAdvance &&
        outgoing.includes(SHOW_CURSOR) &&
        !hasVisibleContent(outgoing)
          ? "\r\n"
          : "";
      if (cursorLineAdvance.length > 0 || payload.length > 0) {
        const written =
          cursorLineAdvance + wrapCursorRewrite(payload, this.resizeSynchronizationOpen);
        trace("OUT", written);
        this.source.write(written);
      }
      if (cursorLineAdvance.length > 0) {
        this.resizeFrameNeedsCursorLineAdvance = false;
      }
      if (this.resizeSynchronizationOpen && hasVisibleContent(outgoing)) {
        this.resizeFrameNeedsCursorLineAdvance = !endsAtNextLine(outgoing);
      }
      if (outgoing.includes(END_SYNCHRONIZED_UPDATE)) {
        this.resizeSynchronizationOpen = false;
        this.resizeFrameNeedsCursorLineAdvance = false;
      }
      if (outgoing.includes(HIDE_CURSOR) && !outgoing.includes(SHOW_CURSOR)) {
        this.queueCursorRefresh();
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private applySyncCloseHold(outgoing: string): string {
    if (!outgoing.includes(END_SYNCHRONIZED_UPDATE)) {
      return outgoing;
    }
    this.clearWithheldSyncTimer();
    if (this.spanSawHide && !this.spanSawShow) {
      // Ink hides the cursor inside the redraw span and restores it in a separate cursor-only
      // span one render later. Closing the first span would blink the input cursor on every
      // history scroll, so the terminal block stays open until the cursor span closes both.
      this.withheldSyncClose = true;
      this.withheldSyncTimer = setTimeout(() => {
        this.withheldSyncTimer = undefined;
        this.releaseWithheldSyncClose();
      }, SYNC_CLOSE_HOLD_MS);
      return outgoing.replace(END_SYNCHRONIZED_UPDATE, "");
    }
    this.withheldSyncClose = false;
    return outgoing;
  }

  private clearWithheldSyncTimer(): void {
    if (this.withheldSyncTimer !== undefined) {
      clearTimeout(this.withheldSyncTimer);
      this.withheldSyncTimer = undefined;
    }
  }

  private releaseWithheldSyncClose(): void {
    if (!this.withheldSyncClose) {
      return;
    }
    this.withheldSyncClose = false;
    this.source.write(END_SYNCHRONIZED_UPDATE);
  }

  private assembleOutgoingWrite(value: string): string | undefined {
    if (this.resizeSynchronizationOpen || value.includes(BEGIN_SYNCHRONIZED_UPDATE)) {
      return value;
    }
    const pending = this.pendingCursorFrame;
    if (pending !== undefined) {
      this.pendingCursorFrame = undefined;
      return pending + value;
    }
    if (value.includes(HIDE_CURSOR) && !value.includes(SHOW_CURSOR)) {
      this.pendingCursorFrame = value;
      this.queueCursorRefresh();
      return undefined;
    }
    return value;
  }

  private flushPendingCursorFrame(): void {
    const pending = this.pendingCursorFrame;
    if (pending === undefined) {
      return;
    }
    this.pendingCursorFrame = undefined;
    this.source.write(wrapCursorRewrite(pending, false));
  }

  private queueCursorRefresh(): void {
    if (this.cursorRefreshQueued) {
      return;
    }
    this.cursorRefreshQueued = true;
    queueMicrotask(() => {
      this.cursorRefreshQueued = false;
      if (!this.destroyed) {
        this.emit(CHAT_CURSOR_REFRESH_EVENT);
      }
    });
  }

  dispose(): void {
    if (this.resizeTimer !== undefined) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.source.off("resize", this.handleSourceResize);
    this.clearWithheldSyncTimer();
    this.releaseWithheldSyncClose();
    this.flushPendingCursorFrame();
    if (this.resizeSynchronizationOpen) {
      this.source.write(END_SYNCHRONIZED_UPDATE);
      this.resizeSynchronizationOpen = false;
      this.resizeFrameNeedsCursorLineAdvance = false;
    }
    this.destroy();
  }
}

export function createChatTerminalOutput(source: NodeJS.WriteStream): ChatTerminalOutput {
  const output = new ManagedChatOutput(source);
  return {
    // Ink only needs the writable stream contract plus dynamic TTY dimensions. The concrete
    // class exposes those properties, while Node's generic Writable type does not declare them.
    stdout: output as unknown as NodeJS.WriteStream,
    dispose: () => output.dispose(),
  };
}
