Labels each workspace by the group the sidebar grouped by status shows it in, so the group shows in any sidebar order:

- Input, orange: an agent asks a question or waits for a permission (Paseo's Needs input).
- Failed, red.
- Working, blue.
- Review, green: Paseo's Ready to review.
- Waiting, sky blue: in Done while an agent waits on a subagent, as the tweaks plugin's Waiting group.
- Idle, yellow: in Done for less than a day, as the tweaks plugin's Idle group.
- Done, indigo: Paseo's label colors have no gray.

Each workspace carries one of these, and the plugin swaps it as the workspace moves. Labels you add yourself stay. It labels a label's first use with the color above; recolor it in Paseo and it keeps your color. Every daemon labels its own workspaces, so install it on every host.

A subagent on another host keeps its starter's workspace in Waiting too, if the starter's daemon reaches that host (Paseo's hosts). Run Mark as done from the tweaks plugin, in the all plugin, and the workspace's label goes from Idle to Done; the separate plugins do not share those marks. In the all plugin, switching it off takes its labels off.

Paseo works out when a workspace entered Done again for every connection, from its agents' last update, so a daemon restart or a reopened chat moves it later than the time the app shows. The plugin keeps the earliest time it has seen for each stay in Done, in `plugin-data/status-labels/done-since.json` in the daemon's home, and starts a new stay when the workspace leaves Done or you send it a message. A workspace it sees for the first time, already in Done, takes the time of its Mark as done if it has one, and otherwise Paseo's time then, which can keep it in Idle longer than the app does.

The plugin SDK has no label calls yet, so the plugin connects to its daemon as the Paseo CLI does, with the daemon's local credential, and needs the daemon to listen on a TCP address. It may stop working after a Paseo update. It sends nothing outside the daemons. It follows up to 200 active workspaces and 200 active agents per host.
