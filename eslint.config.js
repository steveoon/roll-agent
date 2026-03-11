import neostandard, { resolveIgnoresFromGitignore } from "neostandard";

export default neostandard({
  ts: true,
  noStyle: true,
  ignores: resolveIgnoresFromGitignore(),
});
