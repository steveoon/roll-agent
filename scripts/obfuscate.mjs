#!/usr/bin/env node
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { minify } from "terser";

const distDir = resolve(process.cwd(), "dist");

const TERSER_OPTIONS = {
  compress: true,
  mangle: {
    module: true,
    keep_classnames: true,
    keep_fnames: false,
  },
  format: {
    comments: false,
  },
  sourceMap: false,
};

async function main() {
  const entries = await readdir(distDir, { recursive: true });

  const jsFiles = [];
  const mapFiles = [];

  for (const entry of entries) {
    if (entry.endsWith(".js.map") || entry.endsWith(".d.ts.map")) {
      mapFiles.push(entry);
    } else if (entry.endsWith(".js")) {
      jsFiles.push(entry);
    }
  }

  // 1. Delete all map files
  await Promise.all(
    mapFiles.map((f) => unlink(join(distDir, f)).catch(() => {})),
  );
  if (mapFiles.length > 0) {
    console.log(`  Deleted ${mapFiles.length} .map file(s)`);
  }

  // 2. Minify all JS files
  let minified = 0;
  for (const file of jsFiles) {
    const filePath = join(distDir, file);
    const source = await readFile(filePath, "utf-8");

    // Preserve shebang if present
    let shebang = "";
    let code = source;
    if (source.startsWith("#!")) {
      const newlineIndex = source.indexOf("\n");
      if (newlineIndex !== -1) {
        shebang = source.slice(0, newlineIndex + 1);
        code = source.slice(newlineIndex + 1);
      }
    }

    // Strip sourceMappingURL comment
    code = code.replace(/\/\/# sourceMappingURL=.*$/m, "");

    const result = await minify(code, TERSER_OPTIONS);
    if (result.code === undefined) {
      console.error(`  Warning: terser returned no code for ${file}`);
      continue;
    }

    await writeFile(filePath, shebang + result.code + "\n", "utf-8");
    minified++;
  }

  console.log(`  Minified ${minified} JS file(s) in dist/`);
}

main().catch((err) => {
  console.error("obfuscate.mjs failed:", err);
  process.exit(1);
});
