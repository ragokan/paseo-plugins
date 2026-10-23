# Paseo plugins

Plugins for [Paseo](https://paseo.sh), one per folder.

| Plugin | What it does |
|---|---|
| [host-filter](host-filter) | Pick which host the sidebar shows, from the top of the sidebar. |
| [mark-all-read](mark-all-read) | A command palette action that marks every agent on every host as read. |
| [merge-projects](merge-projects) | Show same-named projects from different hosts as one sidebar project. |
| [merge-thinking](merge-thinking) | Fold thinking rows between tool calls into the collapsed tool call group. |
| [mcp-toggle](mcp-toggle) | Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer. |
| [machine-status](machine-status) | CPU, memory, disk, processes, ports and Docker for the Linux machine the daemon runs on. |
| [themes](themes) | Monokai Pro filters as Paseo app themes. |
| [workspace-order](workspace-order) | Keep the sidebar's workspaces (ragokan, coding, ...) in your order, whichever hosts it shows, and hide the ones you pick. |
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
