export const ALLOWED_PREPUBLISH_ONLY = "node ../../scripts/require-pnpm-publish.mjs";

export const PUBLISHED_PACKAGES = [
  { name: "@roll-agent/core", packageJson: "packages/core/package.json" },
  { name: "@roll-agent/sdk", packageJson: "packages/sdk/package.json" },
  {
    name: "@roll-agent/browser",
    packageJson: "packages/browser/package.json",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/reply-authority-client",
    packageJson: "packages/reply-authority-client/package.json",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/browser-use-agent",
    packageJson: "agents/browser-use/package.json",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/smart-reply-agent",
    packageJson: "agents/smart-reply/package.json",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
];
