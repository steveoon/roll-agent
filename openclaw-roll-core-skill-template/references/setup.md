# Setup

## Fresh Machine

Use this sequence when `roll` is not installed yet:

```bash
# 1. Check Node.js
node --version
# Must be >= 22.6.0

# 2. Install roll-core
npm install -g @roll-agent/core
roll --version

# 3. Initialize config
roll config init
# User must edit roll.config.yaml and set provider API keys

# 4. If an existing config uses deprecated schema, migrate it
roll config migrate

# 5. Install browser-use-agent
roll agent install @roll-agent/browser-use-agent

# 6. Start browser-use-agent
roll agent start browser-use-agent

# 7. Open the target platform
roll run browser-use-agent open_platform --input-json '{"platform":"zhipin"}' --json
```

## Important Notes

- Use `roll agent add <path-or-git-url>` for local source directories or Git repositories.
- Use `roll agent install <package-or-tgz>` only for compiled npm packages or tarballs.
- If `roll agent install` receives a local source directory or Git URL, switch to `roll agent add` instead of retrying the same command.
- `browser-use-agent` now defaults to system Chrome. Installation does not default to Playwright Chromium download.
- Login is still a manual step. Wait for the user to finish QR-code scan or credential entry before proceeding.
- Verify login with:

```bash
roll run browser-use-agent zhipin_get_username --json
```

- If this returns a username, the session is active.

## Subsequent Sessions

After first-time setup, the common path is:

```bash
roll agent start browser-use-agent
roll agent health --json
```
