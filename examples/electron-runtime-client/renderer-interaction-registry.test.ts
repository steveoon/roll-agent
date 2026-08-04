import assert from "node:assert/strict";
import test from "node:test";
import {
  RENDERER_INTERACTION_METHODS,
  RendererInteractionRegistry,
  type RendererInteractionAuthority,
} from "./renderer-interaction-registry.ts";

const [approvalRequestMethod, userInputRequestMethod] = RENDERER_INTERACTION_METHODS;

const approvalAuthority = {
  method: approvalRequestMethod,
  webContentsId: 7,
  documentGeneration: 3,
} as const satisfies RendererInteractionAuthority;

function createRegistry(...tokens: readonly string[]): RendererInteractionRegistry {
  let nextToken = 0;
  return new RendererInteractionRegistry(() => tokens[nextToken++] ?? `token-${String(nextToken)}`);
}

test("settles a renderer interaction exactly once", async () => {
  const registry = createRegistry("approval-token");
  const registered = registry.register(approvalAuthority);

  registry.resolve(registered.requestToken, approvalAuthority, { decision: "approve" });

  assert.deepEqual(await registered.promise, { decision: "approve" });
  assert.equal(registry.pendingCount, 0);
  assert.throws(
    () => registry.resolve(registered.requestToken, approvalAuthority, { decision: "reject" }),
    /no longer pending/,
  );
  assert.equal(
    registry.cancel(registered.requestToken, approvalAuthority, new Error("late cancellation")),
    false,
  );
});

test("wrong method, window, and document never consume the valid pending request", async () => {
  const registry = createRegistry("authority-token");
  const registered = registry.register(approvalAuthority);

  const wrongAuthorities: readonly RendererInteractionAuthority[] = [
    {
      ...approvalAuthority,
      method: userInputRequestMethod,
    },
    { ...approvalAuthority, webContentsId: approvalAuthority.webContentsId + 1 },
    { ...approvalAuthority, documentGeneration: approvalAuthority.documentGeneration + 1 },
  ];
  for (const authority of wrongAuthorities) {
    assert.throws(
      () => registry.resolve(registered.requestToken, authority, { decision: "approve" }),
      /not pending for this method, window, and document/,
    );
    assert.equal(registry.pendingCount, 1);
  }

  registry.resolve(registered.requestToken, approvalAuthority, { decision: "approve" });
  assert.deepEqual(await registered.promise, { decision: "approve" });
});

test("wrong-window renderer errors do not delete the valid pending request", async () => {
  const registry = createRegistry("error-token");
  const registered = registry.register(approvalAuthority);

  assert.throws(
    () =>
      registry.reject(
        registered.requestToken,
        { ...approvalAuthority, webContentsId: 99 },
        new Error("wrong window"),
      ),
    /not pending for this method, window, and document/,
  );
  assert.equal(registry.pendingCount, 1);

  const rejection = assert.rejects(registered.promise, /renderer failed/);
  registry.reject(registered.requestToken, approvalAuthority, new Error("renderer failed"));
  await rejection;
  assert.equal(registry.pendingCount, 0);
});

test("document and webContents invalidation reject only their owned requests", async () => {
  const registry = createRegistry("old-document", "new-document", "other-window");
  const oldDocument = registry.register(approvalAuthority);
  const newDocumentAuthority = {
    ...approvalAuthority,
    documentGeneration: approvalAuthority.documentGeneration + 1,
  };
  const newDocument = registry.register(newDocumentAuthority);
  const otherWindowAuthority = { ...approvalAuthority, webContentsId: 8 };
  const otherWindow = registry.register(otherWindowAuthority);
  const oldDocumentRejection = assert.rejects(oldDocument.promise, /navigation started/);

  assert.equal(
    registry.invalidateDocument(
      approvalAuthority.webContentsId,
      approvalAuthority.documentGeneration,
      new Error("navigation started"),
    ),
    1,
  );
  await oldDocumentRejection;
  assert.equal(registry.pendingCount, 2);

  const newDocumentRejection = assert.rejects(newDocument.promise, /renderer exited/);
  assert.equal(
    registry.invalidateWebContents(approvalAuthority.webContentsId, new Error("renderer exited")),
    1,
  );
  await newDocumentRejection;
  assert.equal(registry.pendingCount, 1);

  registry.resolve(otherWindow.requestToken, otherWindowAuthority, { status: "cancelled" });
  assert.deepEqual(await otherWindow.promise, { status: "cancelled" });
});

test("Runtime cancellation wins once and rejects a late renderer response", async () => {
  const registry = createRegistry("cancel-token");
  const registered = registry.register(approvalAuthority);
  const cancellation = assert.rejects(registered.promise, /Runtime cancelled/);

  assert.equal(
    registry.cancel(
      registered.requestToken,
      approvalAuthority,
      new Error("Runtime cancelled the interaction"),
    ),
    true,
  );
  await cancellation;
  assert.throws(
    () => registry.resolve(registered.requestToken, approvalAuthority, { decision: "approve" }),
    /no longer pending/,
  );
});

test("never reuses a settled token that a late renderer could replay", async () => {
  const registry = createRegistry("repeated-entropy", "repeated-entropy");
  const first = registry.register(approvalAuthority);
  registry.resolve(first.requestToken, approvalAuthority, { decision: "approve" });
  await first.promise;

  const second = registry.register(approvalAuthority);
  assert.notEqual(second.requestToken, first.requestToken);
  assert.throws(
    () => registry.resolve(first.requestToken, approvalAuthority, { decision: "reject" }),
    /no longer pending/,
  );
  assert.equal(registry.pendingCount, 1);

  registry.resolve(second.requestToken, approvalAuthority, { decision: "approve" });
  await second.promise;
});
