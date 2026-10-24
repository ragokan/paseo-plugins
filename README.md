# Paseo plugins

Plugins for [Paseo](https://paseo.sh), one per folder.

| Plugin | What it does |
|---|---|
| [tweaks](tweaks) | Hide the sidebar's workspaces you pick, hold new Done ones in Idle for a day, with Mark as done first in the command palette, show the ones waiting on a subagent as Waiting, give Idle its own icon, show host names without the server icon, put the machine before the folder, and gray the Done label. |
| [mark-all-read](mark-all-read) | A command palette action that marks every agent on every host as read. |
| [merge-thinking](merge-thinking) | Fold thinking rows between tool calls into the collapsed tool call group, and thoughts in a row into one group. |
| [mcp-toggle](mcp-toggle) | Turn Claude's and Codex's MCP servers on or off, from the sidebar before a session or from a chat's composer. |
| [machine-status](machine-status) | CPU, memory, disk, processes, ports and Docker for the Linux or macOS machine the daemon runs on, read only while its screen is on screen. |
| [continue-after-error](continue-after-error) | When the daemon starts, resume the Claude and Codex agents a daemon stop, crash or error cut off, but not the ones you stopped. |
| [status-labels](status-labels) | Label each workspace by its sidebar status group: Input, Failed, Working, Review, Waiting, Idle or Done. |
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
