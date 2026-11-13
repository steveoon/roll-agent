# 发布供应链约束

修改发布 workflow、发布/打包脚本、依赖安全策略、npm 发布清单，或准备发布时读取。

本文承接根 [AGENTS.md](../../AGENTS.md) 的专项工程约定。下文源码路径均相对于仓库根目录。

涉及 changeset 编写、semver、版本 PR 或发布验证时，先使用仓库的 [changeset-workflow Skill](../../.agents/skills/changeset-workflow/SKILL.md)。本页维护发布链路必须遵守的约束。

使用 [Changesets](https://github.com/changesets/changesets) 管理版本和发布：

```bash
pnpm changeset
pnpm version-packages
pnpm release-packages
pnpm release-github-releases
```

工作流：功能 PR 附带 `.changeset/*.md` → 合入 `main` → GitHub Action 自动创建 release PR（通常标题为 `chore: version packages`）→ 合并该 PR → 自动 publish → 自动创建 GitHub Releases。

## 发布供应链防护检查清单

每个新的 package version 被 publish 前，都必须按以下链路检查：

```
声明层 -> CI 权限层 -> 依赖解析层 -> 构建层 -> tarball 审计层 -> npm 发布层 -> GitHub Release 层
```

| 层级 | 必查点 | 代码/配置位置 | 失败处理 |
|------|------|------|------|
| 声明层 | 发布包必须属于当前 npm scope，权威白名单由 `scripts/published-packages.mjs` 统一维护；具体包名以该脚本为准 | `scripts/published-packages.mjs`、`scripts/verify-published-packages.mjs` | 不把未知包加入发布清单；新增发布包必须同步 tarball 审计 |
| CI 权限层 | GitHub Actions 必须使用 full SHA pin，不能使用 tag；PR CI 和 release workflow 都要满足仓库级 SHA pin 规则 | `.github/workflows/ci.yml`、`.github/workflows/release.yml` | CI 会在下载 action 前失败；先 pin SHA 再重跑 |
| CI 权限层 | workflow 顶层保持 `permissions: {}`；`quality` 只给 `contents: read`；`release_pr` 只给 `contents: write` + `pull-requests: write`；`npm_publish` 只给 `contents: read` + `id-token: write`；`github_releases` 只给 `contents: write` | `.github/workflows/release.yml` | 不扩大默认 `GITHUB_TOKEN` 权限；不要把 OIDC 与 GitHub 写权限塞进同一 job |
| CI 权限层 | npm 发布使用 Trusted Publishing（OIDC），`npm_publish` 必须持有 `id-token: write`；workflow 不得注入 `NPM_TOKEN` / `NODE_AUTH_TOKEN` | `.github/workflows/release.yml`、`scripts/release-packages.mjs` | publish job 禁止 `setup-node` 的 `registry-url`（会写入空 `_authToken` 并短路 OIDC） |
| token 暴露层 | install/build/test/verify/publish 全程不得注入长期 npm publish token；`release-packages.mjs` 必须剥离 `NPM_TOKEN` / `NODE_AUTH_TOKEN` 等密钥后再跑 | `.github/workflows/release.yml`、`scripts/release-packages.mjs` | 发现 token 回流时立刻移除 |
| token 暴露层 | GitHub Release 创建必须放在 npm publish 成功后的独立 job，只注入 GitHub token，不能注入 npm 凭证 | `.github/workflows/release.yml`、`scripts/create-github-releases.mjs` | 不把 npm 发布权限和 GitHub 写权限交给同一个 job / 第三方 action |
| 依赖解析层 | 使用 `pnpm install --frozen-lockfile`，发布前不能隐式刷新 lockfile | `.github/workflows/*.yml` | lockfile 不一致时先本地审查依赖变化 |
| 依赖解析层 | `minimumReleaseAge: 10080` 必须保留，新解析依赖至少发布满 7 天 | `pnpm-workspace.yaml` | 不能为了临时升级绕过冷却期 |
| 依赖解析层 | `blockExoticSubdeps: true` 必须保留，阻断传递依赖使用 git/tarball 等 exotic source | `pnpm-workspace.yaml` | 需要例外时先做人工供应链审计 |
| 依赖解析层 | `savePrefix: ""` 必须保留，新加依赖默认保存精确版本 | `pnpm-workspace.yaml` | 不机械移除既有 range，但新增依赖应 exact |
| 依赖解析层 | 依赖 denylist 必须包含已知恶意坐标，包括 Shai-Hulud `keyv` 家族坏版本（如 `keyv@6.0.0`） | `scripts/verify-dependency-denylist.mjs` | 命中即失败；不能为了升级依赖而删坐标 |
| build script 层 | `strictDepBuilds: true` 必须保留，未审查的 dependency lifecycle 安装失败；`allowBuilds` denylist 必须显式拒绝当前已知 dependency build scripts，例如 `esbuild`、`unrs-resolver` | `pnpm-workspace.yaml` | 新增 build script 先审计再决定是否允许 |
| 发布 job 层 | `release_pr` / `npm_publish` / `github_releases` 均不能启用 `cache: pnpm`；`quality` job 可以保留 cache | `.github/workflows/release.yml` | 发布相关 job 发现缓存时必须删除 |
| 发布命令层 | CI publish 必须走 `pnpm release-packages` / `node scripts/release-packages.mjs`，不能直接裸跑 `changeset publish` | `package.json`、`scripts/release-packages.mjs` | 保证 publish 前置校验不会被跳过 |
| 发布命令层 | `scripts/release-packages.mjs` 仅允许在 GitHub Actions OIDC 环境发布（校验 `GITHUB_ACTIONS` + `ACTIONS_ID_TOKEN_*`）；不得再写临时 `.npmrc` token | `scripts/release-packages.mjs` | 本地只能 `--dry-run`；真实发布走 Trusted Publisher |
| GitHub Release 层 | npm publish 成功后必须运行 `node scripts/create-github-releases.mjs`，为当前已发布包版本补齐 GitHub Release | `.github/workflows/release.yml`、`scripts/create-github-releases.mjs` | 不能只发布 npm 而丢失 GitHub Releases |
| tarball 审计层 | packed manifest 禁止 `preinstall`、`install`、`postinstall`、`prepare` lifecycle | `scripts/verify-published-packages.mjs` | 命中即失败，禁止发布 |
| tarball 审计层 | packed files 禁止已知可疑文件名：`router_init.js`、`router_runtime.js`、`tanstack_runner.js`、`setup.mjs`、`Math_Symbol.js`、`math_init.js`、`gh-token-monitor` | `scripts/verify-published-packages.mjs` | 命中即失败，先定位来源 |
| tarball 审计层 | packed text 必须扫描已知 IoC：`IfYouRevoke`、`toJSON(secrets)`、`.claude/settings`、`.vscode/tasks`、`@tanstack/setup`、`filev2.getsession` | `scripts/verify-published-packages.mjs` | 命中即失败，不能人工忽略 |

发布前最小验证命令：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:scripts
pnpm test:e2e
pnpm build
pnpm verify:published-packages
node scripts/release-packages.mjs --dry-run
node scripts/create-github-releases.mjs --dry-run
```

边界条件：

- 这套防护不替代 npm Trusted Publisher 配置、org 2FA enforcement、GitHub App 权限收敛和分支保护。每个发布包都需在 npm 单独配置 Trusted Publisher（workflow=`release.yml`）。
- 这套防护不要求每次发布新增人工审批，`Changesets -> release PR -> merge -> OIDC npm publish -> GitHub Releases` 体验保持不变。
- 这套防护不要求机械移除所有既有 `^` / `~`，但新增依赖默认必须 exact。
- 这套防护不覆盖发布后的 runtime 行为审计；它只阻断 CI 依赖解析、发布 job、packed tarball 和 npm publish 链路中的高风险入口。
