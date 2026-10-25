import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { setTimeout as sleep } from "node:timers/promises";
import { generateTitle, readSettings } from "./generate.ts";
import { renameAgent } from "./paseo-cli.ts";
import { candidates, firstMessage, hasDefaultTitle, type FirstMessage, type TimelinePage } from "./title.ts";

// A new agent's first turn starts with a page or so of timeline; an agent past this many entries is not new.
const TIMELINE_LIMIT = 100;
// Codex's turn starts before its first message reaches the timeline, which took 2 seconds in a live run.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** The agent's first message, read again while its turn has started but the message is not in yet. */
export async function readFirstMessage(fetchPage: () => Promise<TimelinePage>, signal: AbortSignal, delays = RETRY_DELAYS_MS): Promise<FirstMessage> {
  for (let attempt = 0; ; attempt++) {
    const first = firstMessage(await fetchPage());
    if (first.kind !== "not-yet" || attempt >= delays.length) return first;
    await sleep(delays[attempt], undefined, { signal });
  }
}

/**
 * Writes a title for the agent from its first message, unless someone has named it. Resolves true once
 * the agent is done with, false when its first message is not in its timeline yet, to try again later.
 */
export async function titleAgent(agent: PluginHookAgent, paseo: PluginHookContext["paseo"], signal: AbortSignal): Promise<boolean> {
  const handle = paseo.agents.ref(agent.id);
  const first = await readFirstMessage(() => handle.timeline.refetch({ direction: "tail", limit: TIMELINE_LIMIT }), signal);
  if (first.kind !== "found") return first.kind === "out-of-reach";
  const snapshot = handle.current();
  if (!hasDefaultTitle(snapshot?.title ?? agent.title, first.text)) return true;

  const settings = readSettings();
  const current = snapshot?.model
    ? { provider: snapshot.provider, model: snapshot.model, ...(snapshot.thinkingOptionId ? { thinkingOptionId: snapshot.thinkingOptionId } : {}) }
    : { provider: agent.provider };
  // Automatic mode picks from the models the providers offer; Manual mode needs only its list.
  const providers = settings.metadataModels.length > 0 ? [] : (await paseo.providers.snapshot()).entries;
  const title = await generateTitle(candidates(settings.metadataModels, providers, current), settings, first.text, signal);

  // You may have renamed it while the model wrote.
  await handle.refresh();
  if (!hasDefaultTitle(handle.current()?.title ?? null, first.text)) return true;
  await renameAgent(agent.id, title, signal);
  console.log(`[agent-titles] ${agent.id}: ${title}`);
  return true;
}
