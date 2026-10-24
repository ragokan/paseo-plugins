Every plugin in this repository in one install: tweaks, mark-all-read, mcp-toggle, merge-thinking, themes, machine-status, continue-after-error and status-labels. Each keeps its own behavior and limits, described in its folder's OVERVIEW.md.

Install it on every host. The app loads a copy for each host that has it, and the copies share the work:

- Tweaks, mark all as read, merge thinking and the Monokai themes change the app itself, so one copy runs them however many hosts have the plugin, and another takes over when that host goes away.
- MCP toggle, machine status, continue after error and status labels act on their own host, so each host runs its own. MCP toggle and machine status add a sidebar row per host, whose screen names the host; machine status starts on only on Linux hosts. Continue after error adds nothing to the app; its switch decides whether the host resumes cut-off agents when its daemon starts. Status labels adds nothing to the app either; it labels its host's workspaces, follows the tweaks' Mark as done, and takes its labels off while switched off.

Turn them on or off from the plugin's "…" menu in Settings → Plugins → Features. The app plugins' switches are saved in the app, so they apply to every host and are the same in every host's Features screen; on iOS and Android they stay on. Each host's own switches are saved on that host. A host switch applies at once in the app you change it in; another open app picks it up when it reloads. While a plugin is off, its app parts are gone and its daemon parts refuse calls and leave agents alone.

Remove the separate plugins from every host that has them, or their sidebar rows, themes and patches appear beside this plugin's. A theme picked from the themes plugin has to be picked again under this one.

Paseo builds a plugin only from its own folder, so on install and update this plugin runs `node build.mjs`, which copies the other folders in. Each daemon needs `node` on its PATH for that.
