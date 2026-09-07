import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { sha256, writeManifest } from "./metadata.mjs";

const directory = resolve(process.argv[2]);
const version = process.argv[3];
await writeManifest(directory, version);
for (const filename of ["install.sh", "install.ps1"]) {
  await cp(join(import.meta.dirname, filename), join(directory, filename), {
    errorOnExist: true,
    force: false,
  });
}
const filenames = (await readdir(directory)).sort();
const rows = [];
for (const filename of filenames) {
  if (!/^[a-zA-Z0-9.-]+$/.test(filename)) throw new Error("Unexpected publication filename");
  if (filename === "CHECKSUMS.sha256") continue;
  rows.push(`${await sha256(join(directory, filename))}  ${filename}\n`);
}
const checksums = rows.join("");
try {
  if ((await readFile(join(directory, "CHECKSUMS.sha256"), "utf8")) !== checksums) {
    throw new Error("Immutable checksum list differs");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(join(directory, "CHECKSUMS.sha256"), checksums, { flag: "wx" });
}
