import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export async function buildInstallBootstrap(outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await build({
    entryPoints: [join(import.meta.dirname, "install-bootstrap-entry.ts")],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    legalComments: "inline",
    metafile: true,
    write: false,
    // Bootstrap always supplies explicit package roots; bundled environment helpers never
    // infer an installation from this temporary executable's location.
    define: { "import.meta.dirname": "__dirname", "import.meta.url": "__filename" },
  });
  // Source comments alone do not contain every package's license grant. Include the actual
  // license of every bundled third-party package in the standalone executable as well.
  const notices = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.split(/[\\/]/).includes("node_modules")) continue;
    let directory = dirname(resolve(input));
    for (;;) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        const key = `${manifest.name}@${manifest.version}`;
        if (!notices.has(key)) {
          let license;
          for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"]) {
            try {
              license = await readFile(join(directory, filename), "utf8");
              break;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          if (!license) throw new Error(`Missing bootstrap dependency license: ${key}`);
          notices.set(key, license);
        }
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || dirname(directory) === directory) throw error;
        directory = dirname(directory);
      }
    }
  }
  const licenses = [...notices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `${name}\n${license}`)
    .join("\n\n");
  await writeFile(
    outputPath,
    `/* THIRD-PARTY SOFTWARE NOTICES\n${licenses.replaceAll("*/", "* /")}\n*/\n${result.outputFiles[0].text}`,
  );
}
