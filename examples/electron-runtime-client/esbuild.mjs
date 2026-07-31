import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const exampleDirectory = import.meta.dirname;
const outputDirectory = join(exampleDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(exampleDirectory, "main.ts")],
    outfile: join(outputDirectory, "main.js"),
    bundle: true,
    external: ["electron", "@roll-agent/client-node", "@roll-agent/protocol"],
    format: "esm",
    platform: "node",
    target: "node22",
  }),
  build({
    entryPoints: [join(exampleDirectory, "preload.ts")],
    outfile: join(outputDirectory, "preload.cjs"),
    bundle: true,
    external: ["electron"],
    format: "cjs",
    platform: "node",
    target: "node22",
  }),
  build({
    entryPoints: [join(exampleDirectory, "renderer.ts")],
    outfile: join(outputDirectory, "renderer.js"),
    bundle: true,
    alias: {
      "@roll-agent/protocol": join(exampleDirectory, "../../packages/protocol/src/index.ts"),
    },
    format: "esm",
    platform: "browser",
    target: "es2022",
  }),
  copyFile(join(exampleDirectory, "index.html"), join(outputDirectory, "index.html")),
  copyFile(join(exampleDirectory, "styles.css"), join(outputDirectory, "styles.css")),
]);
