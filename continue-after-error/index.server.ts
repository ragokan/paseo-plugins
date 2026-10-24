import type { PluginServerContext } from "@getpaseo/plugin/server";
import { paseoCli } from "./server/paseo-cli.ts";
import { resumeCutOffTurns } from "./server/resume.ts";
import { dataDirectory, load, pruneClaims, save } from "./server/store.ts";
import { agentArchived, agentClosed, PROVIDERS, prune, turnEnded, turnStarted, type Turns } from "./server/turns.ts";

export interface ContinueAfterErrorOptions {
  /** Whether to resume anything this daemon start; the all plugin passes its switch. */
  enabled?: () => Promise<boolean>;
}

/**
 * Remembers how each Claude and Codex agent's last turn ended, on disk, and when the daemon starts,
 * resumes the ones a daemon stop, crash or error cut short. Paseo itself keeps no record of why a turn ended.
 */
export default function contribute(server: PluginServerContext, options: ContinueAfterErrorOptions = {}) {
  const directory = dataDirectory();
  const saved = load(directory);
  // The plugin runs as a child of the daemon worker: a new parent means the daemon started, the same one a plugin reload.
  const daemonPid = process.ppid;
  const daemonStarted = saved.daemonPid !== daemonPid;
  let turns = prune(saved.turns, Date.now());
  save(directory, { daemonPid, turns });
  const persist = (next: Turns) => {
    if (next === turns) return;
    turns = next;
    save(directory, { daemonPid, turns });
  };

  server.on("agent.turn_started", ({ agent }) => {
    if (PROVIDERS.has(agent.provider)) persist(turnStarted(turns, agent.id, agent.provider, Date.now()));
  });
  server.on("agent.turn_ended", ({ agent, outcome }) => {
    if (PROVIDERS.has(agent.provider)) persist(turnEnded(turns, agent.id, agent.provider, outcome, Date.now()));
  });
  server.on("agent.closed", ({ agent }) => persist(agentClosed(turns, agent.id, Date.now())));
  server.on("agent.archived", ({ agent }) => persist(agentArchived(turns, agent.id)));

  const stop = new AbortController();
  if (daemonStarted) {
    pruneClaims(directory, Date.now());
    void (async () => {
      if (options.enabled && !(await options.enabled())) return;
      await resumeCutOffTurns({
        turns: () => turns,
        forget: (agentId) => persist(agentArchived(turns, agentId)),
        directory,
        daemonPid,
        cli: paseoCli,
        signal: stop.signal,
      });
    })().catch((error: unknown) => {
      if (!stop.signal.aborted) console.error("[continue-after-error] could not resume cut-off turns", error);
    });
  }
  return () => stop.abort();
}
