---
name: changeset-workflow
description: Guide through the Changesets release workflow for this monorepo. Covers creating changesets, pre-merge validation, and understanding the automated publish pipeline.
---

## Published Packages

| npm 包名 | 本地路径 |
|---|---|
| `@roll-agent/core` | `packages/core` |
| `@roll-agent/sdk` | `packages/sdk` |
| `@roll-agent/browser` | `packages/browser` |
| `@roll-agent/reply-authority-client` | `packages/reply-authority-client` |
| `@roll-agent/browser-use-agent` | `agents/browser-use` |
| `@roll-agent/smart-reply-agent` | `agents/smart-reply` |

`agents/notify` 是 private workspace package，可能因内部依赖被 Changesets 记录版本变化，但不属于 npm 发布清单。

## Step 1: 在功能分支中创建 Changeset

发布型变更需要创建 changeset；纯文档、CI 内部调整、private package 变更或不影响 npm 包用户的改动，通常不需要 changeset。

```bash
pnpm changeset
```

交互式提示：选择受影响的包 → 选择 semver 级别 → 输入变更描述。  
完成后会在 `.changeset/` 下生成一个随机命名的 `.md` 文件；只要创建了 changeset，**必须随 PR 一起提交**。

**Semver 选择标准：**
- `patch` — bug fix、内部重构，不改变公开 API 行为
- `minor` — 新功能，向后兼容
- `major` — breaking change，调用方需要适配

**内部依赖自动传播（`updateInternalDependencies: "patch"`）：**  
修改 `@roll-agent/browser` 时，依赖它的 `@roll-agent/browser-use-agent` 会自动获得一个 patch bump，无需手动选它。其余实际声明 workspace dependency 的消费者同理。

## Step 2: 合并前本地验证清单

本地验证应尽量贴近 release workflow 的 `quality` job：

```bash
pnpm verify:dependency-denylist
pnpm security:audit
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

CLI 懒加载发布校验在改动 `packages/core` CLI、动态 `import()` 或发布入口时必做：

```bash
pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js agent health
```

最后一条命令无已注册 Agent 时输出"暂无已注册 Agent"即通过。失败说明 `dist/` 中存在残留 `.ts` specifier，需在合并前修复。

## Step 3: PR 合入 main 后的自动化流程

PR 合入 main 后，GitHub Actions `release.yml` 自动执行：

1. **quality job** — 依次运行 dependency-denylist、security audit、typecheck、lint、test、e2e、build
2. **release job**（依赖 quality）— install dependencies、build packages，然后调用 `changesets/action`：
   - 若存在 changeset 文件 → 创建或更新标题为 **`chore: version packages`** 的 release PR（执行 `pnpm version-packages` 更新版本号和 CHANGELOG）
   - 若不存在 changeset 文件 → 执行 `node scripts/release-packages.mjs`；常见场景是 release PR 刚合并并触发 npm 发布。若只是无 changeset 的普通 `main` push，脚本完成校验后 `changeset publish` 应没有可发布包。

## Step 4: 发布流程（自动）

`scripts/release-packages.mjs` 自动完成：
1. `pnpm verify:dependency-denylist`
2. `pnpm build`
3. `pnpm verify:published-packages`（校验 `package.json` 中 name / lifecycle scripts 以及 tarball 发布内容合规）
4. 校验发布面：`require-pnpm-publish` guard hash、允许的 `prepublishOnly`、禁止的 publish-time lifecycle scripts
5. 通过临时 `.npmrc` 注入 `secrets.NPM_TOKEN`
6. `pnpm exec changeset publish`
7. 清理临时 `.npmrc`

**不需要也不应该手动执行发布命令。**

## 本地 dry-run 诊断

```bash
node scripts/release-packages.mjs --dry-run
```

仅用于本地诊断，不会发布到 npm。`pnpm release:legacy:dry-run` 是旧发布脚本的诊断入口，不代表当前 release workflow。
