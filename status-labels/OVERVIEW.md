Labels each workspace by the group the sidebar grouped by status shows it in, so the group shows in any sidebar order:

- Input, orange: an agent asks a question or waits for a permission (Paseo's Needs input).
- Failed, red.
- Working, blue.
- Review, green: Paseo's Ready to review.
- Waiting, sky blue: in Done while an agent waits on a subagent, as hide-workspaces' Waiting group.
- Idle, yellow: in Done for less than a day, as hide-workspaces' Idle group.
- Done, indigo: Paseo's label colors have no gray.

Each workspace carries one of these, and the plugin swaps it as the workspace moves. Labels you add yourself stay. It labels a label's first use with the color above; recolor it in Paseo and it keeps your color. Every daemon labels its own workspaces, so install it on every host.

A subagent on another host keeps its starter's workspace in Waiting too, if the starter's daemon reaches that host (Paseo's hosts). Run Mark as done from hide-workspaces, in the all plugin, and the workspace's label goes from Idle to Done; the separate plugins do not share those marks. In the all plugin, switching it off takes its labels off.

The plugin SDK has no label calls yet, so the plugin connects to its daemon as the Paseo CLI does, with the daemon's local credential, and needs the daemon to listen on a TCP address. It may stop working after a Paseo update. It sends nothing outside the daemons. It follows up to 200 active workspaces and 200 active agents per host.
