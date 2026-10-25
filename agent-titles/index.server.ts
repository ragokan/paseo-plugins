import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { titleAgent } from "./server/agent-title.ts";
import { PROVIDERS } from "./server/title.ts";

/**
 * Gives each Claude and Codex agent you start a title from its first message, written by Paseo's
 * metadata model. Paseo writes such titles for workspaces only; an agent keeps its message's first 60 characters.
 */
export default function contribute(server: PluginServerContext) {
  const stop = new AbortController();
  // Agents already dealt with, and those being dealt with; any other agent is looked at when a turn starts or ends.
  const settled = new Set<string>();
  const running = new Set<string>();

  const consider = ({ agent }: { agent: PluginHookAgent }, { paseo }: PluginHookContext) => {
    // An agent another agent started has a parent, and the title its parent gave it.
    if (!PROVIDERS.has(agent.provider) || agent.parentAgentId || settled.has(agent.id) || running.has(agent.id)) return;
    running.add(agent.id);
    void titleAgent(agent, paseo, stop.signal)
      .then((done) => {
        if (done) settled.add(agent.id);
      })
      .catch((error: unknown) => {
        // Not again every turn: a model that failed once likely fails the next time too.
        settled.add(agent.id);
        if (!stop.signal.aborted) console.error(`[agent-titles] could not title ${agent.id}:`, error);
      })
      .finally(() => running.delete(agent.id));
  };
  // The turn's start titles the agent while it works; its end catches a first message that came in late.
  server.on("agent.turn_started", consider);
  server.on("agent.turn_ended", consider);

  return () => stop.abort();
}
