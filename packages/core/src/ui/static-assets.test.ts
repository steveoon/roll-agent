import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFileSystemStaticAssetProvider } from "./static-assets.ts";

describe("createFileSystemStaticAssetProvider", () => {
  it("serves files with content types and blocks traversal through symlinks", async (t) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "roll-ui-assets-"));
    t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
    const root = join(temporaryDirectory, "public");
    const outside = join(temporaryDirectory, "outside.txt");
    await mkdir(root);
    await writeFile(join(root, "index.html"), "<main>Roll UI</main>");
    await writeFile(join(root, "app.js"), "export {};\n");
    await writeFile(outside, "not public");
    await symlink(outside, join(root, "outside.txt"));
    const provider = createFileSystemStaticAssetProvider(root);

    const html = await provider.getAsset("/index.html");
    assert.ok(html !== null);
    assert.equal(html.contentType, "text/html; charset=utf-8");
    assert.equal(Buffer.from(html.body).toString("utf8"), "<main>Roll UI</main>");
    assert.equal(
      (await provider.getAsset("/app.js"))?.contentType,
      "text/javascript; charset=utf-8",
    );
    assert.equal(await provider.getAsset("/outside.txt"), null);
    assert.equal(await provider.getAsset("/../outside.txt"), null);
    assert.equal(await provider.getAsset("//index.html"), null);
    assert.equal(await provider.getAsset("/missing.css"), null);
  });
});
