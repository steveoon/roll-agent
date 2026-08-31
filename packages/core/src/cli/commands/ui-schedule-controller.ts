import { loadConfig } from "../../config/loader.ts";
import { computeAuthorityDigest } from "../../scheduler-host/authority.ts";
import { inspectDaemon } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import {
  SCHEDULER_SERVICE_RESTART_ACTIONS,
  planSchedulerServiceRestart,
} from "../../scheduler-host/service-plan.ts";
import {
  inspectSchedulerServiceState,
  schedulerServiceStatePath,
} from "../../scheduler-host/service-state.ts";
import { withSchedulerServiceManagementLock } from "../../scheduler-host/service.ts";
import {
  createRollUiScheduleController,
  type RollUiScheduleController,
  type ScheduleHostStatus,
} from "../../ui/index.ts";
import { loadRuntime, openScheduleStore } from "./schedule-command-utils.ts";
import {
  assertNodeSqliteAvailable,
  describeSchedulerServiceRestartRefusal,
  installSchedulerServiceUnlocked,
  probeSchedulerService,
  restartSchedulerServiceUnlocked,
  uninstallSchedulerServiceUnlocked,
  type RestartSchedulerServiceResult,
} from "./schedule-service-utils.ts";

export async function createDefaultScheduleController(): Promise<RollUiScheduleController> {
  await assertNodeSqliteAvailable();
  return createRollUiScheduleController({
    ledger: {
      open: async () => {
        const { config } = loadConfig();
        const runtime = await loadRuntime();
        return openScheduleStore(config, runtime);
      },
    },
    host: {
      inspect: async (): Promise<ScheduleHostStatus> => {
        const { config } = loadConfig();
        const paths = createSchedulerPaths(config.scheduler.dataDir);
        const daemon = inspectDaemon(paths.daemonRecordPath);
        const service = await probeSchedulerService();
        return {
          dataDir: paths.dataDir,
          logPath: paths.logPath,
          daemon: {
            liveness: daemon.liveness,
            ...(daemon.record !== undefined
              ? { pid: daemon.record.pid, startedAt: daemon.record.startedAt }
              : {}),
          },
          service,
        };
      },
      installService: async () => {
        const { config } = loadConfig();
        const refreshed = await withSchedulerServiceManagementLock(() =>
          installSchedulerServiceUnlocked(config),
        );
        return { ok: true, refreshed };
      },
      restartService: async () => {
        const notInstalled = planSchedulerServiceRestart({
          inspection: inspectSchedulerServiceState(schedulerServiceStatePath()),
          liveInvocations: 0,
          force: false,
        });
        const result = await withSchedulerServiceManagementLock(
          async (): Promise<RestartSchedulerServiceResult> => {
            if (notInstalled === SCHEDULER_SERVICE_RESTART_ACTIONS.notInstalled) {
              return { action: notInstalled, liveInvocations: 0 };
            }
            const { config } = loadConfig();
            return restartSchedulerServiceUnlocked({ config, force: false });
          },
        );
        if (result.action !== SCHEDULER_SERVICE_RESTART_ACTIONS.restart) {
          throw new Error(describeSchedulerServiceRestartRefusal(result));
        }
        return { ok: true, liveInvocations: result.liveInvocations };
      },
      uninstallService: async () => {
        const uninstalled = await withSchedulerServiceManagementLock(() =>
          uninstallSchedulerServiceUnlocked(),
        );
        return { ok: true, uninstalled };
      },
    },
    authorityDigestFor: (cwd) => computeAuthorityDigest(loadConfig({ cwd }).config),
  });
}
