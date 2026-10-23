# Paseo plugins

Plugins for [Paseo](https://paseo.sh), one per folder.

| Plugin | What it does |
|---|---|
| [hide-workspaces](hide-workspaces) | Hide the sidebar's workspaces you pick, and hold new Done ones in Idle for a day, with Mark as done in the command palette. |
| [mark-all-read](mark-all-read) | A command palette action that marks every agent on every host as read. |
| [merge-thinking](merge-thinking) | Fold thinking rows between tool calls into the collapsed tool call group, and thoughts in a row into one group. |
| [mcp-toggle](mcp-toggle) | Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer. |
| [machine-status](machine-status) | CPU, memory, disk, processes, ports and Docker for the Linux machine the daemon runs on. |
| [themes](themes) | Monokai Pro filters as Paseo app themes. |
| [all](all) | All of the above in one install, each with an on/off switch in the plugin's settings. |

Each folder's `OVERVIEW.md` explains the plugin and its limits.

## Install

Install a plugin by its folder name:

```sh
paseo plugin install git:ragokan/paseo-plugins:mcp-toggle
```

Or install all of them as one plugin, then switch each on or off from its "…" menu in Settings → Plugins → Features:

```sh
paseo plugin install git:ragokan/paseo-plugins:all
```

Update installed plugins with `paseo plugin update`.
