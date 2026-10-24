Shows what the daemon's Linux or macOS machine is doing while your agents work: CPU, memory, swap, disk, power and temperature, the busiest processes, the ports agents and their dev servers listen on, and Docker. Open it from the Machine row in the sidebar or with the command center.

A port of dutchakdev's [Machine status](https://github.com/dutchakdev/paseo-plugin-machine-status) (MIT), which reads macOS. This one reads Linux as well, and leaves out the original's composer pill, which kept every app polling, and its macOS dev-cache cleaner.

## When it reads

Nothing polls in the background. The screen reads the daemon only while it is the one on screen, and only its visible tab. Paseo keeps a screen mounted, hidden, under one opened on top of it, such as Settings, so the screen also stops when the desktop and web apps hide it, or when the sidebar's Machine row says another screen is current. With that row hidden, the iOS and Android apps keep reading while the screen stays open under another.

## How it reads Linux

- Everything comes from `/proc`, `/sys` and `statfs`. Only the ports list runs a command (`ss`), and the Docker tab runs the `docker` CLI.
- CPU is the share of time actually used since the last read, as `top` shows it; load averages are in the detail view. Process CPU is measured between reads too, so a process that just started spinning shows up at once.
- Memory in use is total minus the kernel's `MemAvailable`. Shared memory and tmpfs are shown separately, because `free` counts them as cache but they stay in RAM until deleted. Where the kernel has PSI, the detail views show how long tasks waited for CPU or memory.
- Disk is the filesystem holding your home directory. Machines without a battery or thermal sensors, such as VMs, say so instead of showing estimates.
- A process belongs to an agent when it descends from the Paseo daemon and matches one of the daemon's agents. A port counts as development by its program and path, not its number; system ports appear when you choose **Show system**. Ports owned by other users are listed without a program.
- `docker system df` can take seconds, so it runs in the background, is cached for five minutes, and refreshes after anything the panel removes.

## How it reads macOS

- macOS has no `/proc`, so each read runs the tools it ships: `vm_stat` and `sysctl` for memory and swap, `pmset` for power and thermal state (at most every 30 s), `ps` for processes, and `lsof` with `netstat` for ports. CPU comes from Node's per-core times, and disk from `statfs`.
- Memory is counted as Activity Monitor does: in use is app, wired and compressed memory, and the chart splits it the same way. The memory detail shows macOS's own memory pressure. Swap reads None until macOS adds some.
- Thermal state is what `pmset` reports, without a temperature: macOS shows one only to root.
- `lsof` attributes your own processes' ports; `netstat` adds other users'. macOS hides other processes' sockets from `netstat` when some processes start it; the tab then says so.
- Processes, agents and ports are attributed as on Linux.
- Docker is whichever engine the `docker` CLI talks to: Docker Desktop, OrbStack or Colima.

## What it can change

- **Processes**: SIGTERM first, and force kill only as a separate confirmed step. Paseo and its parent processes are refused, checked again on every kill.
- **Docker**: start, stop, restart and remove containers, view logs, remove images, and prune stopped containers and dangling images. Volumes are never pruned. The Docker daemon itself is a system service or an app, so the tab says how to start it rather than offering a button.

Requires a Linux or macOS daemon. On Windows the screen says it cannot read the machine.
