import type { PluginServerContext } from "@getpaseo/plugin/server";
import { connectDaemon } from "./server/daemon.ts";
import { followLabels } from "./server/follow.ts";
import type { DoneMarks } from "./server/labels.ts";

// How long to wait before trying the daemon again when it does not answer yet, as while it starts.
const RETRY_AFTER = 5_000;

export interface StatusLabelsOptions {
  /** Whether to label now; while it is false the plugin takes its labels off. The all plugin passes its switch. */
  enabled?: () => boolean;
  /** Calls back when enabled() or the marks may have changed; returns a function that stops. */
  onChange?: (listener: () => void) => () => void;
  /** The tweaks plugin's workspaces marked as done in Idle. The all plugin passes its settings. */
  doneMarks?: () => Promise<DoneMarks>;
}

/**
 * Labels each of this host's workspaces by the group the sidebar grouped by status shows it in:
 * Input, Failed, Working, Review, Waiting, Idle or Done. Labels of your own stay.
 */
export default function contribute(_server: PluginServerContext, options: StatusLabelsOptions = {}) {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let close: (() => Promise<void>) | undefined;
  let labels: ReturnType<typeof followLabels> | undefined;
  const stopListening = options.onChange?.(() => labels?.relabel());

  const start = async () => {
    try {
      const { daemon, paseo } = await connectDaemon();
      if (stopped) return void (await daemon.close().catch(() => {}));
      close = () => daemon.close();
      labels = followLabels({
        daemon,
        paseo,
        enabled: options.enabled ?? (() => true),
        doneMarks: options.doneMarks ?? (async () => ({})),
      });
    } catch (error) {
      console.warn("[status-labels] cannot reach the daemon; trying again:", error);
      if (!stopped) retry = setTimeout(() => void start(), RETRY_AFTER);
    }
  };
  void start();

  return async () => {
    stopped = true;
    clearTimeout(retry);
    stopListening?.();
    await labels?.stop();
    await close?.().catch(() => {});
  };
}
