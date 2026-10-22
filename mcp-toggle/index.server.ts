import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listMcpsFor, reloadAgent, setMcpEnabled } from "./server/claude-config";
import { listCodexMcpsFor, setCodexMcpEnabled } from "./server/codex-config";
import { listMcps, listProjects, setMcp } from "./shared/rpc";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  server.handle(listMcps, ({ provider, cwds }) => (provider === "codex" ? listCodexMcpsFor(cwds) : listMcpsFor(cwds)));

  server.handle(listProjects, async (_input, { paseo }) => {
    const { projects } = await paseo.projects.list();
    return projects.map((project) => ({
      name: project.projectCustomName ?? project.projectDisplayName,
      path: project.projectRootPath,
    }));
  });

  server.handle(setMcp, async ({ provider, cwd, name, enabled, agentId }, { paseo }) => {
    if (provider === "codex") await setCodexMcpEnabled(cwd, name, enabled);
    else await setMcpEnabled(cwd, name, enabled);
    if (!agentId) return { reloadError: null };
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    // A reload cancels the running turn, so a running agent is asked to pick it back up.
    const wasRunning = agent.status === "running";
    try {
      await reloadAgent(agentId);
      if (wasRunning) {
        await agent.send(
          `Continue where you left off. The MCP server "${name}" was ${enabled ? "enabled" : "disabled"}, so your session was reloaded.`,
        );
      }
      return { reloadError: null };
    } catch (error) {
      console.error(`[mcp-toggle] could not reload ${agentId}`, describe(error));
      return { reloadError: describe(error) };
    }
  });

  return () => {};
}
