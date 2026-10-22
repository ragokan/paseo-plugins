Turns Claude's MCP servers on or off for a project, using the same per-project list Claude's own `/mcp` command uses (`disabledMcpServers` in `~/.claude.json`).

- **Before a session:** open Manage mcp at the top of the sidebar, pick a project, and flip its servers. New sessions in that project start with that set.
- **During a chat:** the mcp pill above a Claude agent's composer lists the project's servers and whether each is enabled. Picking one toggles it and reloads the agent's session so the change takes effect. If the agent was working, the reload stops its turn and the plugin asks it to continue.

Settings are per project: a subfolder or a worktree uses its main repository's list. ZeroSub account homes get the same change. Reloading uses the `paseo` command-line tool on the daemon's machine. Codex agents and servers from `.mcp.json` files or Claude plugins are not covered.
