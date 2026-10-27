Puts the sidebar's plugin rows and an Update All Plugins action in the command palette.

Every sidebar row a plugin adds, such as ZeroSub's accounts, BrowserOS Neo, Manage MCP servers or Machine, becomes a command with the row's title. The list covers the plugins on every host the app is connected to, each row once, and follows plugins as they are installed, updated or removed. A command opens the row's screen on the selected host when that host has the plugin, else on the first host that does. A sidebar row is the plugin's own component, so this plugin cannot see what it opens: it opens the screen with the row's id, or the plugin's only screen, and leaves out a row that fits neither, such as one that only opens a popover. Paseo's own rows, such as Sessions and Schedules, have commands already.

Update All Plugins installs the newest version of every plugin on every host the app is connected to, as `paseo plugin update --all --yes` does on each, without asking first. It opens a screen that shows each host's progress, what changed, and what failed: an offline host, a host too old to review updates, or a plugin that would not update. Plugins installed from a local folder have no newer version; reload them after editing instead.

The commands show in the palette while one of a host's pages is open and that host has the plugin, so install it on every host you switch to.

The plugin SDK opens only a plugin's own screens and can neither list other plugins nor update them, so this plugin borrows the app's plugin registry, router and connection to each host. It may stop working after a Paseo update: the sidebar commands are then left out, with a warning in the app's console, and Update All Plugins shows an error toast.
