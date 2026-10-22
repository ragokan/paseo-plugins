# Paseo plugins

Plugins for [Paseo](https://paseo.sh), one per folder.

| Plugin | What it does |
|---|---|
| [host-filter](host-filter) | Pick which host the sidebar shows, from the top of the sidebar. |
| [merge-projects](merge-projects) | Show same-named projects from different hosts as one sidebar project. |
| [merge-thinking](merge-thinking) | Fold thinking rows between tool calls into the collapsed tool call group. |
| [mcp-toggle](mcp-toggle) | Turn Claude's MCP servers on or off per project, from the sidebar before a session or from a chat's composer. |
| [themes](themes) | Monokai Pro filters as Paseo app themes. |

Each folder's `OVERVIEW.md` explains the plugin and its limits.

## Install

Install a plugin by its folder name:

```sh
paseo plugin install git:ragokan/paseo-plugins:mcp-toggle
```

Update installed plugins with `paseo plugin update`.
