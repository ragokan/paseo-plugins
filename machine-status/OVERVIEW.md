Shows what the daemon's Linux machine is doing while your agents work: CPU, memory, swap, disk, power and temperature, the busiest processes, the ports agents and their dev servers listen on, and Docker. Open it from the Machine row in the sidebar or with the command center. A pill beside each agent's composer shows CPU busy and memory in use; pressing it opens a card with the trend, the top processes and the ports agents started.

A Linux port of [dutchakdev/machine-status](https://github.com/dutchakdev/paseo-plugin-machine-status) (MIT), without its macOS dev-cache cleaner.

## How it reads

- Everything comes from `/proc`, `/sys` and `statfs`. Only the ports list runs a command (`ss`), and the Docker tab runs the `docker` CLI. Nothing polls in the background: numbers update only while the screen, the card or a composer pill is showing them.
- CPU is the share of time actually used since the last read, as `top` shows it; load averages are in the detail view. Process CPU is measured between reads too, so a process that just started spinning shows up at once.
- Memory in use is total minus the kernel's `MemAvailable`. Shared memory and tmpfs are shown separately, because `free` counts them as cache but they stay in RAM until deleted. Where the kernel has PSI, the detail views show how long tasks waited for CPU or memory.
- Disk is the filesystem holding your home directory. Machines without a battery or thermal sensors, such as VMs, say so instead of showing estimates.
- A process belongs to an agent when it descends from the Paseo daemon and matches one of the daemon's agents. A port counts as development by its program and path, not its number; system ports appear when you choose **Show system**. Ports owned by other users are listed without a program.
- `docker system df` can take seconds, so it runs in the background, is cached for five minutes, and refreshes after anything the panel removes.

## What it can change

- **Processes**: SIGTERM first, and force kill only as a separate confirmed step. Paseo and its parent processes are refused, checked again on every kill.
- **Docker**: start, stop, restart and remove containers, view logs, remove images, and prune stopped containers and dangling images. Volumes are never pruned. The Docker daemon itself is a system service, so the tab says how to start it rather than offering a button.

Requires a Linux daemon. On macOS or Windows the screen says it cannot read the machine.
