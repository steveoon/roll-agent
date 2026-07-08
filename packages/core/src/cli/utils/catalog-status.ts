import { checkPublishedPackageUpdate, fetchLatestPublishedVersion } from "./update-checker.ts";
import type { PublishedPackageUpdateInfo } from "./update-checker.ts";
import type { AgentCatalogEntry } from "../../registry/catalog.ts";
import type { InstalledAgentSource, RegisteredAgent } from "../../types/agent.ts";

export const CATALOG_INSTALL_STATES = [
  "not-installed",
  "installed",
  "installed-other-source",
] as const;
export type CatalogInstallState = (typeof CATALOG_INSTALL_STATES)[number];

export interface CatalogAvailabilityItem {
  readonly entry: AgentCatalogEntry;
  readonly state: CatalogInstallState;
  readonly installedAgent?: RegisteredAgent;
  readonly latestVersion?: string;
  readonly update?: PublishedPackageUpdateInfo;
}

export interface InspectCatalogAvailabilityOptions {
  readonly allowNetwork?: boolean;
  readonly registry?: string;
  readonly fetchLatest?: typeof fetchLatestPublishedVersion;
  readonly checkUpdate?: typeof checkPublishedPackageUpdate;
}

function findInstalledPackageAgent(
  entry: AgentCatalogEntry,
  agents: readonly RegisteredAgent[],
): (RegisteredAgent & { readonly source: InstalledAgentSource }) | undefined {
  for (const agent of agents) {
    if (agent.source?.type === "installed-package" && agent.source.packageName === entry.packageName) {
      return { ...agent, source: agent.source };
    }
  }
  return undefined;
}

export async function inspectCatalogAvailability(
  catalog: readonly AgentCatalogEntry[],
  agents: readonly RegisteredAgent[],
  options: InspectCatalogAvailabilityOptions = {},
): Promise<readonly CatalogAvailabilityItem[]> {
  const fetchLatest = options.fetchLatest ?? fetchLatestPublishedVersion;
  const checkUpdate = options.checkUpdate ?? checkPublishedPackageUpdate;
  const queryOptions = {
    allowNetwork: options.allowNetwork ?? true,
    ...(options.registry ? { registry: options.registry } : {}),
  };

  const items: CatalogAvailabilityItem[] = [];
  for (const entry of catalog) {
    const installed = findInstalledPackageAgent(entry, agents);
    if (installed) {
      const update = await checkUpdate(
        {
          packageName: installed.source.packageName,
          packageSpec: installed.source.packageSpec,
          ...(installed.source.installedVersion
            ? { currentVersion: installed.source.installedVersion }
            : {}),
        },
        queryOptions,
      );
      items.push({
        entry,
        state: "installed",
        installedAgent: installed,
        ...(update.latestVersion ? { latestVersion: update.latestVersion } : {}),
        update,
      });
      continue;
    }

    const latestVersion = await fetchLatest(entry.packageName, queryOptions);
    const otherSource = agents.find((agent) => agent.skill.name === entry.skillName);
    if (otherSource) {
      items.push({
        entry,
        state: "installed-other-source",
        installedAgent: otherSource,
        ...(latestVersion ? { latestVersion } : {}),
      });
      continue;
    }

    items.push({
      entry,
      state: "not-installed",
      ...(latestVersion ? { latestVersion } : {}),
    });
  }
  return items;
}
