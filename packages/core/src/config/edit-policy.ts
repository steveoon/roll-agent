export function isRollConfigReadOnlyPath(path: readonly (string | number)[]): boolean {
  return path.length === 2 && path[0] === "scheduler" && path[1] === "dataDir";
}
