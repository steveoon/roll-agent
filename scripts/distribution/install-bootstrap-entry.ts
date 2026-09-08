import { readFile, writeFile } from "node:fs/promises";
import {
  installWindowsDistribution,
  windowsInstallRequestSchema,
} from "../../packages/core/src/execution-environment/windows-install-bootstrap.ts";

const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Installation interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Missing installer request file");
  const request = windowsInstallRequestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const result = await installWindowsDistribution(request, { signal: controller.signal });
  await writeFile(request.resultPath, JSON.stringify(result), { flag: "wx" });
}
main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  })
  .finally(() => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  });
