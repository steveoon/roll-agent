export const ALLOWED_PREPUBLISH_ONLY = "node ../../scripts/require-pnpm-publish.mjs";

export const PUBLISHED_PACKAGES = [
  {
    name: "@roll-agent/core",
    packageJson: "packages/core/package.json",
    license: "FSL-1.1-ALv2",
  },
  {
    name: "@roll-agent/runtime",
    packageJson: "packages/runtime/package.json",
    license: "FSL-1.1-ALv2",
  },
  {
    name: "@roll-agent/protocol",
    packageJson: "packages/protocol/package.json",
    license: "MIT",
  },
  {
    name: "@roll-agent/relay-protocol",
    packageJson: "packages/relay-protocol/package.json",
    license: "MIT",
  },
  {
    name: "@roll-agent/relay-client",
    packageJson: "packages/relay-client/package.json",
    license: "MIT",
  },
  {
    name: "@roll-agent/client-node",
    packageJson: "packages/client-node/package.json",
    license: "MIT",
  },
  {
    name: "@roll-agent/companion",
    packageJson: "packages/companion/package.json",
    license: "FSL-1.1-ALv2",
  },
  {
    name: "@roll-agent/sdk",
    packageJson: "packages/sdk/package.json",
    license: "MIT",
  },
  {
    name: "@roll-agent/browser",
    packageJson: "packages/browser/package.json",
    license: "FSL-1.1-ALv2",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/reply-authority-client",
    packageJson: "packages/reply-authority-client/package.json",
    license: "FSL-1.1-ALv2",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/browser-use-agent",
    packageJson: "agents/browser-use/package.json",
    license: "FSL-1.1-ALv2",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
  {
    name: "@roll-agent/smart-reply-agent",
    packageJson: "agents/smart-reply/package.json",
    license: "FSL-1.1-ALv2",
    prepublishOnly: ALLOWED_PREPUBLISH_ONLY,
  },
];
