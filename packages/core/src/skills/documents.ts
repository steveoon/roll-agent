import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

const REFERENCE_PATH_PATTERN = /(?:\.\/)?references\/[A-Za-z0-9._~!$&+,;=:@%/-]+/g;
const SUPPORTED_REFERENCE_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".json", ".txt"]);

export interface SkillReferenceDocument {
  readonly relativePath: string;
  readonly path: string;
  readonly content: string;
}

export function collectReferencedSkillPaths(content: string): readonly string[] {
  const references = new Set<string>();
  for (const match of content.matchAll(REFERENCE_PATH_PATTERN)) {
    const normalized = normalizeReferencePath(match[0]);
    if (normalized) {
      references.add(normalized.split(sep).join("/"));
    }
  }

  return [...references].sort();
}

export function readReferencedSkillDocuments(
  skillPath: string,
  content: string,
): readonly SkillReferenceDocument[] {
  const skillDir = dirname(skillPath);
  const realSkillDir = realpathSync(skillDir);
  const references: SkillReferenceDocument[] = [];

  for (const relativePath of collectReferencedSkillPaths(content)) {
    const reference = readReferenceDocument(skillDir, realSkillDir, relativePath);
    if (reference) {
      references.push(reference);
    }
  }

  return references;
}

export function readReferencedSkillDocument(
  skillPath: string,
  referencePath: string,
): SkillReferenceDocument | undefined {
  const normalized = normalizeReferencePath(referencePath.split("/").join(sep));
  if (!normalized) {
    return undefined;
  }
  const skillDir = dirname(skillPath);
  const realSkillDir = realpathSync(skillDir);
  return readReferenceDocument(skillDir, realSkillDir, normalized);
}

function normalizeReferencePath(rawPath: string): string | undefined {
  const withoutDotPrefix = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  const withoutFragment = withoutDotPrefix.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  const normalized = normalize(withoutQuery);

  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    normalized.startsWith("..") ||
    normalized === "references" ||
    !normalized.startsWith(`references${sep}`)
  ) {
    return undefined;
  }

  if (!SUPPORTED_REFERENCE_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    return undefined;
  }

  return normalized;
}

function readReferenceDocument(
  skillDir: string,
  realSkillDir: string,
  referencePath: string,
): SkillReferenceDocument | undefined {
  const candidatePath = resolve(skillDir, referencePath);
  if (!existsSync(candidatePath)) {
    return undefined;
  }

  const realReferencePath = realpathSync(candidatePath);
  const relativeFromSkillDir = relative(realSkillDir, realReferencePath);
  if (relativeFromSkillDir.startsWith("..") || isAbsolute(relativeFromSkillDir)) {
    return undefined;
  }

  if (!statSync(realReferencePath).isFile()) {
    return undefined;
  }

  return {
    relativePath: referencePath.split(sep).join("/"),
    path: realReferencePath,
    content: readFileSync(realReferencePath, "utf-8"),
  };
}
