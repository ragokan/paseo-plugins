Every plugin in this repository in one install: host-filter, mark-all-read, mcp-toggle, merge-projects, merge-thinking, themes, workspace-order and machine-status. Each keeps its own behavior and limits, described in its folder's OVERVIEW.md.

Turn them on or off from the plugin's "…" menu in Settings → Plugins → Features. Everything starts on except machine-status, which only works on a Linux daemon. The switches are saved on the daemon, so each host keeps its own. A change applies at once in the app you make it in; another open app picks it up when it reloads. While a plugin is off, its app parts are gone and its daemon parts refuse calls and leave agents alone.

Install it instead of the separate plugins, on every host that has them: the app loads each host's plugins, so a separate plugin left on any host shows its sidebar rows, themes and patches beside this one's. A theme you picked from the themes plugin has to be picked again under this one.

Paseo builds a plugin only from its own folder, so on install and update this plugin runs `node build.mjs`, which copies the other folders in. The daemon needs `node` on its PATH for that.
