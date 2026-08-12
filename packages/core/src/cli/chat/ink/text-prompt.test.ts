import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { render } from "ink-testing-library";
import { cursorPositionOf, TextPrompt } from "./text-prompt.ts";

const MIXED_WIDTH_DRAFT =
  "这里被丢弃的“孤儿消息”属于父 thread 已经删除的 session，本来就无法通过正常界面恢复，不会影响仍存在的旧对话。";

interface HarnessSink {
  value: string;
  changes: string[];
  submitted: string[];
  slashMoves: number[];
  setValue: (value: string) => void;
}

function makeSink(): HarnessSink {
  return { value: "", changes: [], submitted: [], slashMoves: [], setValue: () => {} };
}

interface HarnessProps {
  readonly sink: HarnessSink;
  readonly initial?: string;
  readonly inputHistory?: readonly string[];
  readonly disabled?: boolean;
  readonly slashActive?: boolean;
  readonly slashPopupActive?: boolean;
  readonly ignoreChanges?: boolean;
  readonly width?: number;
  readonly viewportRows?: number;
  readonly maxRows?: number;
  readonly showHint?: boolean;
}

function Harness(props: HarnessProps): ReactElement {
  const [value, setValue] = useState(props.initial ?? "");
  props.sink.value = value;
  props.sink.setValue = setValue;
  const slashActive = props.slashActive ?? value.startsWith("/");
  return h(TextPrompt, {
    value,
    width: props.width ?? 100,
    viewportRows: props.viewportRows ?? 12,
    maxRows: props.maxRows ?? 12,
    showHint: props.showHint ?? true,
    inputHistory: props.inputHistory ?? [],
    disabled: props.disabled ?? false,
    slashActive,
    slashPopupActive: props.slashPopupActive ?? slashActive,
    autoApprove: false,
    onChange: (next: string) => {
      props.sink.changes.push(next);
      if (props.ignoreChanges !== true) {
        setValue(next);
      }
    },
    onSubmit: (submitted: string) => {
      props.sink.submitted.push(submitted);
    },
    onSlashMove: (direction: 1 | -1) => {
      props.sink.slashMoves.push(direction);
    },
    onSlashComplete: () => {},
    onSlashRun: () => {},
  });
}

type Stdin = { write: (data: string) => void };

async function type(stdin: Stdin, ...chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks) {
    stdin.write(chunk);
    await delay(10);
  }
}

test("left arrow moves cursor so insertion lands mid-string", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ac", "\x1b[D", "b");
  assert.equal(sink.value, "abc");
  unmount();
});

test("right arrow moves back and is a no-op at end", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x1b[C", "\x1b[D", "\x1b[C", "c");
  assert.equal(sink.value, "abc");
  unmount();
});

test("home and end keys work in both legacy encodings", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x1b[H", "x", "\x1b[F", "y");
  assert.equal(sink.value, "xaby");
  await type(stdin, "\x1b[1~", "1", "\x1b[4~", "2");
  assert.equal(sink.value, "1xaby2");
  unmount();
});

test("ctrl+a and ctrl+e jump to line start and end", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x01", "x", "\x05", "y");
  assert.equal(sink.value, "xaby");
  unmount();
});

test("ctrl+u kills to line start and ctrl+k kills to line end", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "abcd", "\x1b[D", "\x15");
  assert.equal(sink.value, "d");
  await type(stdin, "xy", "\x0b");
  assert.equal(sink.value, "xy");
  unmount();
});

test("ctrl+w deletes the previous word", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "foo bar", "\x17");
  assert.equal(sink.value, "foo ");
  unmount();
});

test("windows ctrl+arrow word jumps", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "foo bar", "\x1b[1;5D", "x");
  assert.equal(sink.value, "foo xbar");
  await type(stdin, "\x1b[1;5C", "!");
  assert.equal(sink.value, "foo xbar!");
  unmount();
});

test("macos option+arrow word jumps in both encodings", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "foo bar", "\x1b[1;3D", "x");
  assert.equal(sink.value, "foo xbar");
  await type(stdin, "\x1bb", "y");
  assert.equal(sink.value, "foo yxbar");
  await type(stdin, "\x1bf", "z");
  assert.equal(sink.value, "foo yxbarz");
  await type(stdin, "\x1b[1;3C", "!");
  assert.equal(sink.value, "foo yxbarz!");
  unmount();
});

test("forward delete removes character after cursor", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "abc", "\x1b[3~");
  assert.equal(sink.value, "abc");
  await type(stdin, "\x1b[H", "\x1b[3~");
  assert.equal(sink.value, "bc");
  unmount();
});

test("backspace variants delete before cursor", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "abc", "\x7f");
  assert.equal(sink.value, "ab");
  await type(stdin, "\x08");
  assert.equal(sink.value, "a");
  unmount();
});

test("option+backspace deletes the previous word", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "foo bar", "\x1b\x7f");
  assert.equal(sink.value, "foo ");
  unmount();
});

test("kitty encodings resolve to the same commands", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x1b[127u");
  assert.equal(sink.value, "a");
  await type(stdin, "b", "\x1b[97;5u", "x");
  assert.equal(sink.value, "xab");
  await type(stdin, "\x05", " word", "\x1b[119;5u");
  assert.equal(sink.value, "xab ");
  unmount();
});

test("CJK insertion at cursor position", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "你好", "\x1b[D", "呀");
  assert.equal(sink.value, "你呀好");
  unmount();
});

test("emoji ZWJ cluster moves and deletes as one unit", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "👩‍👩‍👧‍👦a", "\x1b[D", "\x7f");
  assert.equal(sink.value, "a");
  unmount();
});

test("up and down arrows move between draft lines", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\n", "cd", "\x1b[A", "X");
  assert.equal(sink.value, "abX\ncd");
  await type(stdin, "\x1b[B", "Y");
  assert.equal(sink.value, "abX\ncdY");
  unmount();
});

test("up arrow on single-line draft has no side effect", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink, inputHistory: ["older input"] }));
  await delay(10);
  await type(stdin, "ab", "\x1b[A", "c");
  assert.equal(sink.value, "abc");
  assert.deepEqual(sink.submitted, []);
  unmount();
});

test("empty draft browses input history from newest to oldest and back to empty", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(
    h(Harness, { sink, inputHistory: ["first", "second", "third"] }),
  );
  await delay(10);

  await type(stdin, "\x1b[A");
  assert.equal(sink.value, "third");
  await type(stdin, "\x1b[A");
  assert.equal(sink.value, "second");
  await type(stdin, "\x1b[B");
  assert.equal(sink.value, "third");
  await type(stdin, "\x1b[B");
  assert.equal(sink.value, "");
  unmount();
});

test("editing a recalled input exits history navigation", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink, inputHistory: ["first", "second"] }));
  await delay(10);

  await type(stdin, "\x1b[A", "!", "\x1b[A");
  assert.equal(sink.value, "second!");
  unmount();
});

test("history navigation takes priority after recalling a slash command", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(
    h(Harness, { sink, inputHistory: ["/help", "middle", "latest"] }),
  );
  await delay(10);

  await type(stdin, "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[B");
  assert.equal(sink.value, "middle");
  assert.deepEqual(sink.slashMoves, []);
  unmount();
});

test("bracketed paste inserts multiline text at cursor without submitting", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "\x1b[200~x\r\ny\x1b[201~");
  assert.equal(sink.value, "x\ny");
  assert.deepEqual(sink.submitted, []);
  unmount();
});

test("external value replacement resets cursor to end", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x1b[H");
  sink.setValue("/help ");
  await delay(20);
  await type(stdin, "x");
  assert.equal(sink.value, "/help x");
  unmount();
});

test("rapid input accumulates without rereading an unchanged value prop", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink, ignoreChanges: true }));
  await delay(10);
  await type(stdin, "a", "b");
  assert.deepEqual(sink.changes, ["a", "ab"]);
  unmount();
});

test("enter submits the full value even with cursor mid-string", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\x1b[D", "\r");
  assert.deepEqual(sink.submitted, ["ab"]);
  unmount();
});

test("slash popup arrows take priority over cursor movement", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(
    h(Harness, { sink, initial: "/t", slashActive: true, slashPopupActive: true }),
  );
  await delay(10);
  await type(stdin, "\x1b[A", "\x1b[B");
  assert.deepEqual(sink.slashMoves, [-1, 1]);
  assert.equal(sink.value, "/t");
  unmount();
});

test("cursorPositionOf maps offsets to rows and columns", () => {
  const lines = ["ab", "cd"];
  assert.deepEqual(cursorPositionOf(lines, 0), { row: 0, col: 0 });
  assert.deepEqual(cursorPositionOf(lines, 2), { row: 0, col: 2 });
  assert.deepEqual(cursorPositionOf(lines, 3), { row: 1, col: 0 });
  assert.deepEqual(cursorPositionOf(lines, 5), { row: 1, col: 2 });
  assert.deepEqual(cursorPositionOf([""], 0), { row: 0, col: 0 });
});

test("multiline draft renders every line with its prefix", async () => {
  const sink = makeSink();
  const { stdin, lastFrame, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "ab", "\n", "cd");
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.match(frame, /› ab/);
  assert.match(frame, /cd/);
  unmount();
});

test("moving through a wrapped mixed-width draft preserves its layout", async () => {
  const sink = makeSink();
  const { stdin, lastFrame, unmount } = render(h(Harness, { sink, initial: MIXED_WIDTH_DRAFT }));
  await delay(20);
  const before = stripVTControlCharacters(lastFrame() ?? "");
  await type(stdin, ...Array.from({ length: 12 }, () => "\x1b[D"));
  const after = stripVTControlCharacters(lastFrame() ?? "");
  assert.equal(after, before);
  unmount();
});

test("mixed-width drafts use the remaining row before wrapping", async () => {
  const sink = makeSink();
  const { lastFrame, unmount } = render(h(Harness, { sink, initial: MIXED_WIDTH_DRAFT }));
  await delay(20);
  const [, firstInputRow = "", secondInputRow = ""] = stripVTControlCharacters(
    lastFrame() ?? "",
  ).split("\n");
  assert.match(firstInputRow, /› 这里/);
  assert.match(firstInputRow, /session.*不会影响/);
  assert.match(secondInputRow, /仍存在的旧对话。/);
  unmount();
});

test("up arrow moves through soft-wrapped visual rows", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(
    h(Harness, { sink, initial: MIXED_WIDTH_DRAFT, inputHistory: ["older input"] }),
  );
  await delay(20);
  await type(stdin, "\x1b[A", "X");
  assert.equal(sink.value.replace("X", ""), MIXED_WIDTH_DRAFT);
  assert.equal(sink.value.endsWith("X"), false);
  unmount();
});

test("disabled prompt renders without a cursor placeholder crash", async () => {
  const sink = makeSink();
  const { lastFrame, unmount } = render(h(Harness, { sink, initial: "ab", disabled: true }));
  await delay(20);
  assert.match(lastFrame() ?? "", /ab/);
  unmount();
});

test("long multiline drafts keep the cursor tail visible inside the prompt row budget", async () => {
  const sink = makeSink();
  const initial = Array.from({ length: 10 }, (_, index) => `line-${String(index)}`).join("\n");
  const { lastFrame, unmount } = render(h(Harness, { sink, initial, maxRows: 5, showHint: false }));
  await delay(20);
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.doesNotMatch(frame, /line-0/);
  assert.match(frame, /line-9/);
  assert.ok(frame.split("\n").length <= 5);
  unmount();
});

test("SGR mouse bytes never enter the prompt draft", async () => {
  const sink = makeSink();
  const { stdin, unmount } = render(h(Harness, { sink }));
  await delay(10);
  await type(stdin, "\u001B[<64;10;5M");
  assert.equal(sink.value, "");
  unmount();
});

interface AttachmentHarnessProps {
  readonly sink: HarnessSink;
  readonly attachments?: readonly { name: string; sizeLabel: string }[];
  readonly pasted?: string[];
  readonly consumePaste?: boolean;
  readonly removed?: { count: number };
}

function AttachmentHarness(props: AttachmentHarnessProps): ReactElement {
  const [value, setValue] = useState("");
  props.sink.value = value;
  props.sink.setValue = setValue;
  return h(TextPrompt, {
    value,
    width: 100,
    viewportRows: 12,
    maxRows: 12,
    showHint: true,
    inputHistory: [],
    disabled: false,
    slashActive: false,
    slashPopupActive: false,
    autoApprove: false,
    ...(props.attachments !== undefined ? { attachments: props.attachments } : {}),
    onChange: (next: string) => {
      props.sink.changes.push(next);
      setValue(next);
    },
    onSubmit: (submitted: string) => {
      props.sink.submitted.push(submitted);
    },
    onSlashMove: () => {},
    onSlashComplete: () => {},
    onSlashRun: () => {},
    onPasteText: (text: string) => {
      props.pasted?.push(text);
      return props.consumePaste ?? false;
    },
    onRemoveLastAttachment: () => {
      if (props.removed !== undefined) {
        props.removed.count += 1;
      }
    },
  });
}

test("onPasteText 消费粘贴后不再插入文本", async () => {
  const sink = makeSink();
  const pasted: string[] = [];
  const { stdin, unmount } = render(h(AttachmentHarness, { sink, pasted, consumePaste: true }));
  await delay(10);
  await type(stdin, "\x1b[200~/tmp/shot.png\x1b[201~");
  assert.deepEqual(pasted, ["/tmp/shot.png"]);
  assert.equal(sink.value, "");
  unmount();
});

test("onPasteText 放行时按原文插入", async () => {
  const sink = makeSink();
  const pasted: string[] = [];
  const { stdin, unmount } = render(h(AttachmentHarness, { sink, pasted, consumePaste: false }));
  await delay(10);
  await type(stdin, "\x1b[200~普通文本\x1b[201~");
  assert.deepEqual(pasted, ["普通文本"]);
  assert.equal(sink.value, "普通文本");
  unmount();
});

test("附件 chip 行渲染文件名与大小", async () => {
  const sink = makeSink();
  const { lastFrame, unmount } = render(
    h(AttachmentHarness, {
      sink,
      attachments: [
        { name: "shot.png", sizeLabel: "118KB" },
        { name: "b.jpg", sizeLabel: "2.1MB" },
      ],
    }),
  );
  await delay(10);
  const frame = stripVTControlCharacters(lastFrame() ?? "");
  assert.match(frame, /shot\.png 118KB/u);
  assert.match(frame, /b\.jpg 2\.1MB/u);
  assert.match(frame, /空输入退格移除/u);
  unmount();
});

test("空输入退格移除最后一个附件，非空输入退格删字符", async () => {
  const sink = makeSink();
  const removed = { count: 0 };
  const { stdin, unmount } = render(
    h(AttachmentHarness, {
      sink,
      removed,
      attachments: [{ name: "shot.png", sizeLabel: "118KB" }],
    }),
  );
  await delay(10);
  await type(stdin, "\x7f");
  assert.equal(removed.count, 1);
  await type(stdin, "ab", "\x7f");
  assert.equal(sink.value, "a");
  assert.equal(removed.count, 1);
  unmount();
});

test("Ctrl+V 触发剪贴板图像回调而不落入编辑器", async () => {
  const sink = makeSink();
  let requested = 0;
  const { stdin, unmount } = render(
    h(TextPrompt, {
      value: "",
      width: 100,
      viewportRows: 12,
      maxRows: 12,
      showHint: true,
      inputHistory: [],
      disabled: false,
      slashActive: false,
      slashPopupActive: false,
      autoApprove: false,
      onChange: (next: string) => {
        sink.changes.push(next);
      },
      onSubmit: () => {},
      onSlashMove: () => {},
      onSlashComplete: () => {},
      onSlashRun: () => {},
      onRequestClipboardImage: () => {
        requested += 1;
      },
    }),
  );
  await delay(10);
  await type(stdin, "\x16");
  assert.equal(requested, 1);
  assert.deepEqual(sink.changes, []);
  unmount();
});

test("读取剪贴板 pending 状态渲染提示行", async () => {
  const sink = makeSink();
  const { lastFrame, unmount } = render(h(AttachmentHarness, { sink, attachments: [] }));
  await delay(10);
  const idleFrame = stripVTControlCharacters(lastFrame() ?? "");
  assert.doesNotMatch(idleFrame, /读取剪贴板/u);
  unmount();

  const pendingSink = makeSink();
  const pending = render(
    h(TextPrompt, {
      value: "",
      width: 100,
      viewportRows: 12,
      maxRows: 12,
      showHint: true,
      inputHistory: [],
      disabled: false,
      slashActive: false,
      slashPopupActive: false,
      autoApprove: false,
      attachmentsPending: true,
      onChange: (next: string) => {
        pendingSink.changes.push(next);
      },
      onSubmit: () => {},
      onSlashMove: () => {},
      onSlashComplete: () => {},
      onSlashRun: () => {},
    }),
  );
  await delay(10);
  const pendingFrame = stripVTControlCharacters(pending.lastFrame() ?? "");
  assert.match(pendingFrame, /读取剪贴板…/u);
  pending.unmount();
});
