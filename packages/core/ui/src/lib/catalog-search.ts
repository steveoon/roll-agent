import { matchesCatalogNodeSelf, matchesCatalogSearch } from "./config-value.ts";
import type {
  AgentConfigCatalog,
  AgentEnvCatalogField,
  ConfigCatalogNode,
  NavigationTarget,
  RollConfigCatalog,
} from "../types.ts";

export interface CatalogSearchMatches {
  readonly rollModules: readonly (readonly [string, ConfigCatalogNode])[];
  readonly agents: readonly AgentConfigCatalog[];
}

export interface CatalogSearchResult {
  readonly target: NavigationTarget;
  readonly path: readonly string[];
  readonly focusPath: readonly string[];
  readonly title: string;
  readonly description?: string;
}

export function getCatalogSearchMatches(
  catalog: RollConfigCatalog,
  query: string,
): CatalogSearchMatches {
  const normalized = query.trim().toLocaleLowerCase();
  return {
    rollModules: Object.entries(catalog.root.fields).filter(([, node]) =>
      matchesCatalogSearch(node, normalized),
    ),
    agents: catalog.agents.filter((agent) => matchesAgentCatalogSearch(agent, normalized)),
  };
}

export function getCatalogSearchResults(
  catalog: RollConfigCatalog,
  query: string,
): readonly CatalogSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [];
  const results: CatalogSearchResult[] = [];
  for (const [key, node] of Object.entries(catalog.root.fields)) {
    collectNodeSearchResults(node, { type: "roll", key }, normalized, results);
  }
  for (const agent of catalog.agents) {
    const target: NavigationTarget = { type: "agent", name: agent.name };
    if (matchesAgentIdentity(agent, normalized)) {
      results.push({
        target,
        path: ["agents", "env", agent.name],
        focusPath: ["agents", "env", agent.name],
        title: agent.name,
        description: agent.description,
      });
    }
    for (const field of agent.fields) {
      if (!matchesAgentEnvField(field, normalized)) continue;
      const path = ["agents", "env", agent.name, field.name];
      results.push({
        target,
        path,
        focusPath: path,
        title: field.title,
        ...(field.description !== undefined ? { description: field.description } : {}),
      });
    }
  }
  return results;
}

export function resolveVisibleNavigationTarget(
  active: NavigationTarget,
  matches: CatalogSearchMatches,
): NavigationTarget | undefined {
  if (matchesTarget(active, matches)) return active;
  const firstRoll = matches.rollModules[0];
  if (firstRoll !== undefined) return { type: "roll", key: firstRoll[0] };
  const firstAgent = matches.agents[0];
  return firstAgent === undefined ? undefined : { type: "agent", name: firstAgent.name };
}

export function matchesAgentCatalogSearch(agent: AgentConfigCatalog, query: string): boolean {
  if (query.length === 0 || matchesAgentIdentity(agent, query)) return true;
  return agent.fields.some((field) => matchesAgentEnvField(field, query));
}

export function matchesAgentIdentity(agent: AgentConfigCatalog, query: string): boolean {
  return [agent.name, agent.description, agent.ownership]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function matchesAgentEnvField(field: AgentEnvCatalogField, query: string): boolean {
  if (query.length === 0) return true;
  return [field.name, field.title, field.description ?? "", field.example ?? ""]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function resolveValidationIssueTarget(
  catalog: RollConfigCatalog,
  issuePath: string,
): NavigationTarget | undefined {
  const segments = issuePath.split(".");
  const rootKey = segments[0];
  if (rootKey === "agents" && segments[1] === "env") {
    const agentName = segments[2];
    return agentName !== undefined && catalog.agents.some((agent) => agent.name === agentName)
      ? { type: "agent", name: agentName }
      : undefined;
  }
  return rootKey !== undefined && catalog.root.fields[rootKey] !== undefined
    ? { type: "roll", key: rootKey }
    : undefined;
}

function matchesTarget(target: NavigationTarget, matches: CatalogSearchMatches): boolean {
  return target.type === "roll"
    ? matches.rollModules.some(([key]) => key === target.key)
    : matches.agents.some((agent) => agent.name === target.name);
}

function collectNodeSearchResults(
  node: ConfigCatalogNode,
  target: NavigationTarget,
  query: string,
  results: CatalogSearchResult[],
): void {
  if (node.path.length > 1 && matchesCatalogNodeSelf(node, query)) {
    const wildcardIndex = node.path.findIndex((segment) => segment === "*");
    const focusPath = wildcardIndex === -1 ? node.path : node.path.slice(0, wildcardIndex);
    results.push({
      target,
      path: node.path,
      focusPath: focusPath.length > 0 ? focusPath : node.path,
      title: node.title,
      ...(node.description !== undefined ? { description: node.description } : {}),
    });
  }
  if (node.kind === "object") {
    for (const child of Object.values(node.fields)) {
      collectNodeSearchResults(child, target, query, results);
    }
    return;
  }
  if (node.kind === "record") {
    collectNodeSearchResults(node.value, target, query, results);
    return;
  }
  if (node.kind === "array") collectNodeSearchResults(node.item, target, query, results);
}
