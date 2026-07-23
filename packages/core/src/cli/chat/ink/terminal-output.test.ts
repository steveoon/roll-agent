import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CHAT_CURSOR_REFRESH_EVENT, createChatTerminalOutput } from "./terminal-output.ts";

class TestOutput extends EventEmitter {
  columns = 100;
  rows = 30;
  readonly isTTY = true;
  readonly chunks: string[] = [];

  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }
}

class SlowOutput extends TestOutput {
  readonly pendingCallbacks: Array<(error?: Error | null) => void> = [];

  override write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(String(chunk));
    if (callback !== undefined) {
      this.pendingCallbacks.push(callback);
    }
    return false;
  }

  flush(): void {
    for (const callback of this.pendingCallbacks.splice(0)) {
      callback();
    }
  }
}

function asWriteStream(output: TestOutput): NodeJS.WriteStream {
  return output as unknown as NodeJS.WriteStream;
}

test("managed chat output coalesces resize bursts at the latest dimensions", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  const rendererColumns: number[] = [];
  const consumerColumns: number[] = [];
  managed.stdout.on("resize", () => {
    rendererColumns.push(managed.stdout.columns);
  });
  managed.stdout.on("resize", () => {
    consumerColumns.push(managed.stdout.columns);
  });

  source.columns = 80;
  source.emit("resize");
  source.columns = 60;
  source.emit("resize");
  source.columns = 120;
  source.emit("resize");
  managed.stdout.write("intermediate frame");

  assert.deepEqual(rendererColumns, []);
  assert.deepEqual(consumerColumns, []);
  assert.deepEqual(source.chunks, []);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(rendererColumns, [99, 120]);
  assert.deepEqual(consumerColumns, [120]);
  assert.equal(source.chunks.join(""), "\u001B[?2026h\u001B[2J\u001B[H");
  managed.dispose();
});

test("managed chat output converts full-terminal clears into viewport-only clears", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));

  await new Promise<void>((resolve, reject) => {
    managed.stdout.write("\u001B[2J\u001B[3J\u001B[Hframe", (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  assert.equal(source.chunks.join(""), "\u001B[2J\u001B[Hframe");
  managed.dispose();
});

test("managed chat output replaces Ink's relative resize clear with one clean full frame", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  const rendererColumns: number[] = [];
  managed.stdout.on("resize", () => {
    rendererColumns.push(managed.stdout.columns);
    if (rendererColumns.length === 1) {
      managed.stdout.write("\u001B[2K\u001B[1A");
      managed.stdout.write("fresh frame");
    }
  });

  source.columns = 80;
  source.emit("resize");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(rendererColumns, [79, 80]);
  assert.equal(source.chunks.join(""), "\u001B[?2026h\u001B[2J\u001B[Hfresh frame");
  managed.dispose();
});

test("managed chat output keeps synchronized resize writes in source order", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  const rendererColumns: number[] = [];
  managed.stdout.on("resize", () => {
    rendererColumns.push(managed.stdout.columns);
    managed.stdout.write("\u001B[2K\u001B[1A");
    managed.stdout.write("\u001B[?2026h");
    managed.stdout.write("\u001B[2K\u001B[1A");
    managed.stdout.write("fresh synchronized frame");
    managed.stdout.write("\u001B[?2026l");
  });

  source.columns = 80;
  source.emit("resize");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(rendererColumns, [79, 80]);
  assert.equal(
    source.chunks.join(""),
    "\u001B[?2026h\u001B[2J\u001B[H\u001B[?2026h\u001B[2K\u001B[1Afresh synchronized frame\u001B[?2026l",
  );
  managed.dispose();
});

test("managed chat output advances into the reserved row before a resize cursor suffix", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  managed.stdout.on("resize", () => {
    managed.stdout.write("\u001B[2K\u001B[1A");
    managed.stdout.write("fixed-height frame\u001B[39m");
    managed.stdout.write("\u001B[2A\u001B[7G\u001B[?25h\u001B[?2026l");
  });

  source.columns = 80;
  source.emit("resize");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(
    source.chunks.join(""),
    "\u001B[?2026h\u001B[2J\u001B[Hfixed-height frame\u001B[39m\r\n" +
      "\u001B[2A\u001B[7G\u001B[?25h\u001B[?2026l",
  );
  managed.dispose();
});

test("managed chat output recognizes Ink's follow-up viewport redraw", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));

  managed.stdout.write("\u001B[?2026h");
  managed.stdout.write("\u001B[2J\u001B[Hfixed-height follow-up frame\u001B[39m");
  managed.stdout.write("\u001B[2A\u001B[7G\u001B[?25h\u001B[?2026l");

  assert.equal(
    source.chunks.join(""),
    "\u001B[?2026h\u001B[2J\u001B[Hfixed-height follow-up frame\u001B[39m\r\n" +
      "\u001B[2A\u001B[7G\u001B[?25h\u001B[?2026l",
  );
  managed.dispose();
});

test("managed chat output does not hold stdout BEGIN behind direct terminal diagnostics", () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));

  managed.stdout.write("\u001B[?2026h");
  assert.equal(source.chunks.join(""), "\u001B[?2026h");
  source.write("diagnostic");
  managed.stdout.write("frame\u001B[?2026l");

  assert.equal(source.chunks.join(""), "\u001B[?2026hdiagnosticframe\u001B[?2026l");
  managed.dispose();
});

test("managed chat output cancels a pending resize when disposed", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  let resized = false;
  managed.stdout.on("resize", () => {
    resized = true;
  });

  source.emit("resize");
  managed.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(resized, false);
  assert.equal(source.listenerCount("resize"), 0);
});

test("managed chat output drops stale frames even when the real stdout is backpressured", async () => {
  const source = new SlowOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  managed.stdout.on("resize", () => {
    const columns = managed.stdout.columns;
    managed.stdout.write("\u001B[2K\u001B[1A");
    managed.stdout.write(`fresh:${String(columns)}`);
  });

  managed.stdout.write("inflight");
  source.columns = 80;
  source.emit("resize");
  managed.stdout.write("stale");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  source.flush();

  assert.doesNotMatch(source.chunks.join(""), /stale/);
  assert.match(source.chunks.join(""), /fresh:79/);
  managed.dispose();
});

test("managed chat output does not treat an IME cursor frame as resize cleanup", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));

  source.columns = 80;
  source.emit("resize");
  managed.stdout.write("stale frame\u001B[?25h");
  managed.stdout.write("\u001B[?25h\u001B[?1000l");

  assert.equal(source.chunks.join(""), "\u001B[?25h\u001B[?1000l");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.doesNotMatch(source.chunks.join(""), /stale frame/);
  managed.dispose();
});

test("managed chat output requests a cursor refresh when a sibling frame hides it", async () => {
  const source = new TestOutput();
  const managed = createChatTerminalOutput(asWriteStream(source));
  let refreshes = 0;
  managed.stdout.on(CHAT_CURSOR_REFRESH_EVENT, () => {
    refreshes += 1;
  });

  managed.stdout.write("\u001B[?25lrewritten sibling frame");
  await Promise.resolve();
  assert.equal(refreshes, 1);

  managed.stdout.write("\u001B[?25lframe with restored cursor\u001B[?25h");
  await Promise.resolve();
  assert.equal(refreshes, 1);
  managed.dispose();
});
