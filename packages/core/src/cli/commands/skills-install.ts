import { defineCommand } from "citty";
import { resolve } from "node:path";
import { expandTilde, loadAgentsConfig } from "../../config/loader.ts";
import {
  collectInstallableSkills,
  findExistingSkillInstalls,
  installSkillsToDir,
} from "../../skills/install.ts";
import {
  ORCHESTRATOR_SKILL_TARGETS,
  detectOrchestratorTargets,
  isOrchestratorTargetId,
} from "../../skills/orchestrators.ts";
import { cloneOrPullRepo, isGitUrl, repoNameFromUrl } from "../utils/git-source.ts";
import { log } from "../utils/output.ts";
import { ConfigSetupCancelledError, clackPromptAdapter } from "./config-prompts.ts";
import type { InstalledSkillRecord, SkillInstallCandidate } from "../../skills/install.ts";
import type { OrchestratorTargetId } from "../../skills/orchestrators.ts";

interface SkillInstallTargetResult {
  readonly target: string | null;
  readonly dir: string;
  readonly skills: readonly InstalledSkillRecord[];
}

export default defineCommand({
  meta: {
    description: "安装 skill 到 orchestrator 的 skills 目录（Claude Code / Codex / 通用 .agents）",
  },
  args: {
    source: {
      type: "positional",
      description: "skill 来源：包含 SKILL.md 的本地目录（或多 skill 子目录集合）、Git 仓库 URL",
      required: true,
    },
    target: {
      type: "string",
      description: `目标 orchestrator，逗号分隔或 all（${ORCHESTRATOR_SKILL_TARGETS.map((t) => `${t.id}=${t.userDir}`).join("、")}；agents 目录同时被 roll chat 读取）`,
    },
    project: {
      type: "boolean",
      description: "安装到当前项目目录（如 .claude/skills）而非用户级目录",
      default: false,
    },
    dir: {
      type: "string",
      description: "自定义目标目录（与 --target 互斥）",
    },
    skill: {
      type: "string",
      description: "只安装指定名称的 skill，逗号分隔（默认安装来源中的全部 skill）",
    },
    json: {
      type: "boolean",
      description: "JSON 格式输出安装结果",
      default: false,
    },
  },
  async run({ args }) {
    if (args.dir && (args.target || args.project)) {
      log.error("--dir 与 --target / --project 互斥，请只指定一种目标方式");
      process.exitCode = 1;
      return;
    }

    let sourceDir: string;
    if (isGitUrl(args.source)) {
      const { agentsConfig } = loadAgentsConfig();
      const cloneTarget = resolve(
        agentsConfig.dataDir,
        "skill-repos",
        repoNameFromUrl(args.source),
      );
      try {
        const { action } = await cloneOrPullRepo(args.source, cloneTarget);
        log.info(action === "cloned" ? `已克隆到 ${cloneTarget}` : `已更新 ${cloneTarget}`);
      } catch (err) {
        log.error(`拉取 skill 仓库失败: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      sourceDir = cloneTarget;
    } else {
      sourceDir = resolve(expandTilde(args.source));
    }

    const collected = collectInstallableSkills(sourceDir);
    for (const issue of collected.issues) {
      log.warn(issue);
    }

    const skills = filterRequestedSkills(collected.skills, args.skill);
    if (!skills) {
      process.exitCode = 1;
      return;
    }
    if (skills.length === 0) {
      log.error(`未在 ${sourceDir} 找到可安装的 skill`);
      process.exitCode = 1;
      return;
    }

    let targetDirs: readonly { readonly id: string | null; readonly dir: string }[];
    try {
      const resolved = await resolveTargetDirs(args);
      if (!resolved) {
        process.exitCode = 1;
        return;
      }
      targetDirs = resolved;
    } catch (err) {
      if (err instanceof ConfigSetupCancelledError) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    const results: SkillInstallTargetResult[] = [];
    for (const { id, dir } of targetDirs) {
      const existing = findExistingSkillInstalls(skills, dir);
      if (existing.length > 0) {
        log.warn(`将覆盖 ${dir} 中已有的 skill（手工修改会丢失）: ${existing.join(", ")}`);
      }
      const records = installSkillsToDir(skills, dir);
      results.push({ target: id, dir, skills: records });
      for (const record of records) {
        log.success(`${record.overwritten ? "已更新" : "已安装"} ${record.name} → ${record.targetPath}`);
      }
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    }
  },
});

function filterRequestedSkills(
  skills: readonly SkillInstallCandidate[],
  skillArg: string | undefined,
): readonly SkillInstallCandidate[] | undefined {
  if (!skillArg) {
    return skills;
  }
  const requested = skillArg
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const missing = requested.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    log.error(
      `来源中不存在这些 skill: ${missing.join(", ")}（可用: ${skills.map((s) => s.name).join(", ")}）`,
    );
    return undefined;
  }
  return requested.map((name) => byName.get(name)).filter((skill) => skill !== undefined);
}

async function resolveTargetDirs(args: {
  readonly dir?: string;
  readonly target?: string;
  readonly project: boolean;
}): Promise<readonly { readonly id: string | null; readonly dir: string }[] | undefined> {
  if (args.dir) {
    return [{ id: null, dir: resolve(expandTilde(args.dir)) }];
  }

  const detected = detectOrchestratorTargets({ project: args.project });
  const byId = new Map(detected.map((item) => [item.target.id, item]));

  if (args.target) {
    const ids =
      args.target === "all"
        ? ORCHESTRATOR_SKILL_TARGETS.map((target) => target.id)
        : args.target
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
    const invalid = ids.filter((id) => !isOrchestratorTargetId(id));
    if (invalid.length > 0) {
      log.error(
        `未知的 --target: ${invalid.join(", ")}（可选: ${ORCHESTRATOR_SKILL_TARGETS.map((t) => t.id).join("、")}、all）`,
      );
      return undefined;
    }
    return ids.filter(isOrchestratorTargetId).flatMap((id) => {
      const item = byId.get(id);
      return item ? [{ id, dir: item.skillsDir }] : [];
    });
  }

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    log.error("非交互模式需要指定 --target 或 --dir");
    return undefined;
  }

  const selectable = detected.flatMap((item) =>
    isOrchestratorTargetId(item.target.id) ? [{ item, id: item.target.id }] : [],
  );
  const selected = await clackPromptAdapter.multiselect<OrchestratorTargetId>({
    message: "选择要安装到的 orchestrator（空格勾选，回车确认）",
    options: selectable.map(({ item, id }) => ({
      value: id,
      label: `${item.target.label}（${item.skillsDir}）`,
      ...(item.present ? {} : { hint: "未检测到使用痕迹" }),
    })),
    initialValues: selectable.filter(({ item }) => item.present).map(({ id }) => id),
    required: true,
  });

  return selected.flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ id, dir: item.skillsDir }] : [];
  });
}
