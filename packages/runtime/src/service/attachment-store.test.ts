import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { threadIdSchema, attachmentIdSchema } from "@roll-agent/protocol";
import { AttachmentStore } from "./attachment-store.ts";

const THREAD_A = threadIdSchema.parse("00000000-0000-4000-8000-00000000aa01");
const THREAD_B = threadIdSchema.parse("00000000-0000-4000-8000-00000000aa02");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-attachment-store-"));
}

function withStore(
  run: (context: {
    readonly store: AttachmentStore;
    readonly workDir: string;
    readonly advance: (ms: number) => void;
  }) => void,
  options: { readonly maxStagedAttachments?: number; readonly maxAttachmentBytes?: number } = {},
): void {
  const storeDir = tempDir();
  const workDir = tempDir();
  let nowMs = 1_000_000;
  const store = new AttachmentStore({
    dir: join(storeDir, "attachments"),
    stagedTtlMs: 10_000,
    committedTtlMs: 60_000,
    now: () => nowMs,
    ...(options.maxStagedAttachments !== undefined
      ? { maxStagedAttachments: options.maxStagedAttachments }
      : {}),
    ...(options.maxAttachmentBytes !== undefined
      ? { maxAttachmentBytes: options.maxAttachmentBytes }
      : {}),
  });
  try {
    run({
      store,
      workDir,
      advance: (ms) => {
        nowMs += ms;
      },
    });
  } finally {
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function writeSource(workDir: string, name: string, data: Buffer): string {
  const path = join(workDir, name);
  writeFileSync(path, data);
  return path;
}

test("local-path stage 一步 commit 并产出安全 descriptor", () => {
  withStore(({ store, workDir }) => {
    const data = Buffer.from("fake png bytes");
    const sourcePath = writeSource(workDir, "My Shot.png", data);
    const staged = store.stage({
      threadId: THREAD_A,
      fileName: "My Shot.png",
      mediaType: "image/png",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(staged.ok);
    assert.equal(staged.state, "committed");
    assert.ok(staged.descriptor);
    assert.equal(staged.descriptor.displayName, "My Shot.png");
    assert.equal(staged.descriptor.mediaType, "image/png");
    assert.equal(staged.descriptor.bytes, data.length);
    assert.doesNotMatch(JSON.stringify(staged.descriptor), /workDir|\/tmp\//u);

    const read = store.readCommitted({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(read.ok);
    assert.equal(read.dataBase64, data.toString("base64"));
  });
});

test("local-path 校验拒绝相对路径、symlink、大小与 hash 不匹配", () => {
  withStore(({ store, workDir }) => {
    const data = Buffer.from("payload");
    const sourcePath = writeSource(workDir, "a.png", data);
    const base = {
      threadId: THREAD_A,
      fileName: "a.png",
      mediaType: "image/png",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
    } as const;

    const relative = store.stage({ ...base, sourcePath: "relative/a.png" });
    assert.ok(!relative.ok && relative.code === "ATTACHMENT_PATH_REJECTED");

    const linkPath = join(workDir, "link.png");
    symlinkSync(sourcePath, linkPath);
    const viaSymlink = store.stage({ ...base, sourcePath: linkPath });
    assert.ok(!viaSymlink.ok && viaSymlink.code === "ATTACHMENT_PATH_REJECTED");

    const wrongSize = store.stage({ ...base, bytes: data.length + 1, sourcePath });
    assert.ok(!wrongSize.ok && wrongSize.code === "INVALID_PARAMS");

    const wrongHash = store.stage({ ...base, sha256: "0".repeat(64), sourcePath });
    assert.ok(!wrongHash.ok && wrongHash.code === "ATTACHMENT_HASH_MISMATCH");

    const missing = store.stage({ ...base, sourcePath: join(workDir, "ghost.png") });
    assert.ok(!missing.ok && missing.code === "ATTACHMENT_PATH_REJECTED");
  });
});

test("类型白名单与扩展名一致性", () => {
  withStore(({ store, workDir }) => {
    const data = Buffer.from("x");
    const sourcePath = writeSource(workDir, "notes.txt", data);
    const mismatch = store.stage({
      threadId: THREAD_A,
      fileName: "notes.txt",
      mediaType: "image/png",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(!mismatch.ok && mismatch.code === "ATTACHMENT_TYPE_UNSUPPORTED");

    const okText = store.stage({
      threadId: THREAD_A,
      fileName: "notes.txt",
      mediaType: "text/plain",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(okText.ok && okText.state === "committed");
  });
});

test("local-path 拒绝 fileName 合法但 sourcePath 扩展名与 mediaType 不一致的文件", () => {
  withStore(({ store, workDir }) => {
    const data = Buffer.from("secret-material");
    const sourcePath = writeSource(workDir, "id_ed25519.pem", data);
    const disguised = store.stage({
      threadId: THREAD_A,
      fileName: "note.txt",
      mediaType: "text/plain",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(!disguised.ok && disguised.code === "ATTACHMENT_TYPE_UNSUPPORTED");
    assert.match(disguised.message, /sourcePath 扩展名/u);
  });
});

test("chunks 生命周期：顺序上传、commit 校验、hash 不匹配即回收", () => {
  withStore(({ store }) => {
    const part1 = Buffer.from("hello ");
    const part2 = Buffer.from("world");
    const full = Buffer.concat([part1, part2]);
    const staged = store.stage({
      threadId: THREAD_A,
      fileName: "b.jpg",
      mediaType: "image/jpeg",
      bytes: full.length,
      sha256: sha256(full),
      source: "chunks",
    });
    assert.ok(staged.ok);
    assert.equal(staged.state, "staged");
    assert.equal(staged.descriptor, undefined);

    const early = store.commit({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(!early.ok && early.code === "ATTACHMENT_UPLOAD_INCOMPLETE");

    const outOfOrder = store.appendChunk({
      threadId: THREAD_A,
      attachmentId: staged.attachmentId,
      sequence: 1,
      dataBase64: part1.toString("base64"),
    });
    assert.ok(!outOfOrder.ok && outOfOrder.code === "INVALID_PARAMS");

    const first = store.appendChunk({
      threadId: THREAD_A,
      attachmentId: staged.attachmentId,
      sequence: 0,
      dataBase64: part1.toString("base64"),
    });
    assert.ok(first.ok);
    assert.equal(first.receivedBytes, part1.length);
    const second = store.appendChunk({
      threadId: THREAD_A,
      attachmentId: staged.attachmentId,
      sequence: 1,
      dataBase64: part2.toString("base64"),
    });
    assert.ok(second.ok);

    const committed = store.commit({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(committed.ok);
    assert.equal(committed.descriptor.bytes, full.length);

    const rerun = store.commit({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(rerun.ok);

    const badHash = store.stage({
      threadId: THREAD_A,
      fileName: "c.jpg",
      mediaType: "image/jpeg",
      bytes: part1.length,
      sha256: "0".repeat(64),
      source: "chunks",
    });
    assert.ok(badHash.ok);
    store.appendChunk({
      threadId: THREAD_A,
      attachmentId: badHash.attachmentId,
      sequence: 0,
      dataBase64: part1.toString("base64"),
    });
    const mismatch = store.commit({ threadId: THREAD_A, attachmentId: badHash.attachmentId });
    assert.ok(!mismatch.ok && mismatch.code === "ATTACHMENT_HASH_MISMATCH");
    const gone = store.readCommitted({ threadId: THREAD_A, attachmentId: badHash.attachmentId });
    assert.ok(!gone.ok && gone.code === "ATTACHMENT_NOT_FOUND");
  });
});

test("chunks 累计超过申报大小立即回收", () => {
  withStore(({ store }) => {
    const staged = store.stage({
      threadId: THREAD_A,
      fileName: "d.webp",
      mediaType: "image/webp",
      bytes: 3,
      sha256: "0".repeat(64),
      source: "chunks",
    });
    assert.ok(staged.ok);
    const overflow = store.appendChunk({
      threadId: THREAD_A,
      attachmentId: staged.attachmentId,
      sequence: 0,
      dataBase64: Buffer.from("too much data").toString("base64"),
    });
    assert.ok(!overflow.ok && overflow.code === "ATTACHMENT_TOO_LARGE");
    const gone = store.commit({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(!gone.ok && gone.code === "ATTACHMENT_NOT_FOUND");
  });
});

test("附件归属 thread：跨 thread 访问视为不存在", () => {
  withStore(({ store, workDir }) => {
    const data = Buffer.from("owned");
    const sourcePath = writeSource(workDir, "owned.png", data);
    const staged = store.stage({
      threadId: THREAD_A,
      fileName: "owned.png",
      mediaType: "image/png",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(staged.ok);
    const crossThread = store.readCommitted({
      threadId: THREAD_B,
      attachmentId: staged.attachmentId,
    });
    assert.ok(!crossThread.ok && crossThread.code === "ATTACHMENT_NOT_FOUND");

    store.releaseThread(THREAD_A);
    const afterRelease = store.readCommitted({
      threadId: THREAD_A,
      attachmentId: staged.attachmentId,
    });
    assert.ok(!afterRelease.ok && afterRelease.code === "ATTACHMENT_NOT_FOUND");
  });
});

test("TTL 过期回收 staged 与 committed 附件并清理磁盘", () => {
  withStore(({ store, workDir, advance }) => {
    const data = Buffer.from("expiring");
    const sourcePath = writeSource(workDir, "e.png", data);
    const committed = store.stage({
      threadId: THREAD_A,
      fileName: "e.png",
      mediaType: "image/png",
      bytes: data.length,
      sha256: sha256(data),
      source: "local-path",
      sourcePath,
    });
    assert.ok(committed.ok);
    const staged = store.stage({
      threadId: THREAD_A,
      fileName: "f.png",
      mediaType: "image/png",
      bytes: 8,
      sha256: "0".repeat(64),
      source: "chunks",
    });
    assert.ok(staged.ok);

    advance(10_001);
    const stagedGone = store.commit({ threadId: THREAD_A, attachmentId: staged.attachmentId });
    assert.ok(!stagedGone.ok && stagedGone.code === "ATTACHMENT_NOT_FOUND");
    const committedAlive = store.readCommitted({
      threadId: THREAD_A,
      attachmentId: committed.attachmentId,
    });
    assert.ok(committedAlive.ok);

    advance(60_000);
    const committedGone = store.readCommitted({
      threadId: THREAD_A,
      attachmentId: committed.attachmentId,
    });
    assert.ok(!committedGone.ok && committedGone.code === "ATTACHMENT_NOT_FOUND");
  });
});

test("staging 并发配额与 release 幂等", () => {
  withStore(
    ({ store }) => {
      const stageChunked = (name: string) =>
        store.stage({
          threadId: THREAD_A,
          fileName: name,
          mediaType: "image/png",
          bytes: 8,
          sha256: "0".repeat(64),
          source: "chunks",
        });
      const first = stageChunked("q1.png");
      assert.ok(first.ok);
      const second = stageChunked("q2.png");
      assert.ok(!second.ok && second.code === "ATTACHMENT_QUOTA_EXCEEDED");
      assert.equal(second.retryable, true);

      const released = store.release({ threadId: THREAD_A, attachmentId: first.attachmentId });
      assert.deepEqual(released, { ok: true, released: true });
      const again = store.release({ threadId: THREAD_A, attachmentId: first.attachmentId });
      assert.deepEqual(again, { ok: true, released: false });

      const third = stageChunked("q3.png");
      assert.ok(third.ok);
    },
    { maxStagedAttachments: 1 },
  );
});

test("并存实例互不破坏：新实例构造不删活跃实例的附件，close 只清自己", () => {
  const storeDir = join(tempDir(), "attachments");
  const workDir = tempDir();
  const data = Buffer.from("survivor");
  const sourcePath = join(workDir, "s.png");
  writeFileSync(sourcePath, data);
  const first = new AttachmentStore({ dir: storeDir });
  const staged = first.stage({
    threadId: THREAD_A,
    fileName: "s.png",
    mediaType: "image/png",
    bytes: data.length,
    sha256: sha256(data),
    source: "local-path",
    sourcePath,
  });
  assert.ok(staged.ok);

  const second = new AttachmentStore({ dir: storeDir });
  const survived = first.readCommitted({
    threadId: THREAD_A,
    attachmentId: attachmentIdSchema.parse(staged.attachmentId),
  });
  assert.ok(survived.ok);
  assert.equal(survived.dataBase64, data.toString("base64"));

  second.close();
  const afterSecondClose = first.readCommitted({
    threadId: THREAD_A,
    attachmentId: attachmentIdSchema.parse(staged.attachmentId),
  });
  assert.ok(afterSecondClose.ok);
  first.close();
  assert.equal(readdirSync(storeDir).length, 0);
  rmSync(workDir, { recursive: true, force: true });
});

test("构造时清扫超龄的孤儿实例目录", () => {
  const storeDir = join(tempDir(), "attachments");
  const staleDir = join(storeDir, "00000000-dead-4000-8000-000000000001");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "orphan.bin"), Buffer.from("orphan"));
  const staleMs = Date.now() - 10 * 60 * 60 * 1_000;
  utimesSync(staleDir, staleMs / 1_000, staleMs / 1_000);

  const store = new AttachmentStore({ dir: storeDir });
  assert.equal(existsSync(staleDir), false);
  store.close();
});

test("local-path committed 附件计入暂存配额", () => {
  withStore(
    ({ store, workDir }) => {
      const data = Buffer.from("quota");
      const sourcePath = writeSource(workDir, "q.png", data);
      const base = {
        threadId: THREAD_A,
        fileName: "q.png",
        mediaType: "image/png",
        bytes: data.length,
        sha256: sha256(data),
        source: "local-path",
        sourcePath,
      } as const;
      const first = store.stage(base);
      assert.ok(first.ok && first.state === "committed");
      const second = store.stage(base);
      assert.ok(!second.ok && second.code === "ATTACHMENT_QUOTA_EXCEEDED");
      assert.match(second.message, /attachment\.release/u);
      assert.doesNotMatch(second.message, /在 turn\.start 中引用或/u);

      store.release({ threadId: THREAD_A, attachmentId: first.attachmentId });
      const third = store.stage(base);
      assert.ok(third.ok);
    },
    { maxStagedAttachments: 1 },
  );
});

test("local-path 实际文件超限时报 ATTACHMENT_TOO_LARGE 而非申报不一致", () => {
  withStore(
    ({ store, workDir }) => {
      const data = Buffer.alloc(2_048);
      const sourcePath = writeSource(workDir, "big.png", data);
      const lied = store.stage({
        threadId: THREAD_A,
        fileName: "big.png",
        mediaType: "image/png",
        bytes: 512,
        sha256: sha256(data),
        source: "local-path",
        sourcePath,
      });
      assert.ok(!lied.ok && lied.code === "ATTACHMENT_TOO_LARGE");
      assert.match(lied.message, /实际大小/u);

      const honestButOversized = store.stage({
        threadId: THREAD_A,
        fileName: "big.png",
        mediaType: "image/png",
        bytes: 1_024,
        sha256: sha256(data),
        source: "local-path",
        sourcePath,
      });
      assert.ok(!honestButOversized.ok && honestButOversized.code === "ATTACHMENT_TOO_LARGE");
    },
    { maxAttachmentBytes: 1_024 },
  );
});
