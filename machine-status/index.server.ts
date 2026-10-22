import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  controlContainerHandler,
  pruneDockerHandler,
  readContainerLogsHandler,
  readDockerHandler,
  removeImageHandler,
} from "./server/docker.ts";
import { explainProcessHandler } from "./server/explain.ts";
import { readMetricsHandler } from "./server/metrics.ts";
import { killProcessHandler, listProcessesHandler } from "./server/processes.ts";
import { readServicesHandler } from "./server/services.ts";
import { killProcess, listProcesses, readMetrics } from "./shared/contracts.ts";
import { controlContainer, pruneDocker, readContainerLogs, readDocker, removeImage } from "./shared/docker.ts";
import { explainProcess } from "./shared/explain.ts";
import { readServices } from "./shared/services.ts";

/**
 * The daemon half of the plugin. Every file read, command, path and signal stays
 * here, behind a Zod contract the app calls over RPC; nothing under `client/`
 * can touch the machine directly.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(readMetrics, readMetricsHandler);
  server.handle(listProcesses, listProcessesHandler);
  server.handle(killProcess, killProcessHandler);
  server.handle(readServices, readServicesHandler);
  server.handle(explainProcess, explainProcessHandler);
  server.handle(readDocker, readDockerHandler);
  server.handle(controlContainer, controlContainerHandler);
  server.handle(readContainerLogs, readContainerLogsHandler);
  server.handle(pruneDocker, pruneDockerHandler);
  server.handle(removeImage, removeImageHandler);

  // No timers, watchers or sockets are created at registration time, so there is
  // nothing to release. Paseo removes the handlers and stops the subprocess.
  return () => {};
}
