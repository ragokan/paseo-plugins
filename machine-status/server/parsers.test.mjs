// Pure parsers over captured Linux output; no machine state is read.
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildMemory, buildPower, buildSwap, buildThermal, busyBetween, diskFrom, mountPointFor, parseMeminfo, parsePressure, parseStat, usageBetween } =
  await import("./metrics.ts");
const { commandFrom, cpuBetween, formatElapsed, parseProcStat } = await import("./proc.ts");
const { matchAgentRoots, parseSsListeners } = await import("./services.ts");
const { classifyRelevance, normalizeAgents, scopeOf } = await import("../shared/services-classify.ts");
const { describeKnown } = await import("./explain-rules.ts");

const KB = 1024;
const GB = 1024 ** 3;

const MEMINFO = `MemTotal:       65722688 kB
MemFree:        12038172 kB
MemAvailable:   23596176 kB
Buffers:          342568 kB
Cached:         34489444 kB
SwapCached:            0 kB
AnonPages:      16812556 kB
Shmem:          23773528 kB
SReclaimable:    1149628 kB
SUnreclaim:       433500 kB
KernelStack:       27856 kB
PageTables:        95656 kB
SecPageTables:         0 kB
SwapTotal:       2097148 kB
SwapFree:        1048576 kB
HugePages_Total:       0
`;

test("memory in use is total minus available, and tmpfs is not counted as reclaimable cache", () => {
  const info = parseMeminfo(MEMINFO);
  assert.equal(info.MemTotal, 65722688 * KB);
  assert.equal(info.HugePages_Total, 0);
  const memory = buildMemory(info, 1.5);
  assert.equal(memory.usedBytes, (65722688 - 23596176) * KB);
  assert.equal(memory.availableBytes, 23596176 * KB);
  assert.equal(memory.appBytes, 16812556 * KB);
  assert.equal(memory.sharedBytes, 23773528 * KB);
  assert.equal(memory.kernelBytes, (433500 + 27856 + 95656) * KB);
  assert.equal(memory.cachedBytes, (342568 + 34489444 + 1149628 - 23773528) * KB);
  assert.ok(Math.abs(memory.usedPercent - 64.1) < 0.1);
  assert.equal(memory.stallPercent, 1.5);
  assert.deepEqual(buildSwap(info), { totalBytes: 2097148 * KB, usedBytes: 1048572 * KB, freeBytes: 1048576 * KB });
});

test("old kernels without MemAvailable fall back to free plus cache", () => {
  const memory = buildMemory(parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n"), null);
  assert.equal(memory.availableBytes, 400 * KB);
  assert.equal(memory.usedBytes, 600 * KB);
});

test("PSI reads the 10 s average of the some line", () => {
  assert.equal(parsePressure("some avg10=12.34 avg60=1.00 avg300=0.20 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), 12.34);
  assert.equal(parsePressure(""), null);
});

test("CPU busy counts idle and iowait as idle, and leaves guest time out", () => {
  const before = parseStat("cpu  100 0 100 700 100 0 0 0 50 0\nintr 1 2 3\n").all;
  const after = parseStat("cpu  200 0 200 1300 300 0 0 0 90 0\n").all;
  assert.deepEqual(before, { busy: 200, total: 1000, user: 100, system: 100, steal: 0, iowait: 100 });
  assert.equal(busyBetween(before, after), 20);
  assert.equal(busyBetween(after, after), 0);
  assert.equal(parseStat("intr 1 2 3"), null);
});

test("per-core use and the user / system / steal / iowait split come from the same interval", () => {
  const before = parseStat(
    ["cpu  100 0 100 600 100 0 0 100 0 0", "cpu0 50 0 50 300 50 0 0 50 0 0", "cpu2 50 0 50 300 50 0 0 50 0 0", "intr 1"].join("\n"),
  );
  const after = parseStat(
    [
      "cpu  250 10 150 1100 200 10 10 270 0 0",
      "cpu0 150 10 70 380 60 10 10 60 0 0",
      "cpu2 70 0 60 650 140 0 0 80 0 0",
      "cpu3 30 0 20 70 0 0 0 0 0 0",
    ].join("\n"),
  );
  assert.deepEqual([...after.cores.keys()], [0, 2, 3]);
  const usage = usageBetween(before, after);
  // Δtotal 1000: user 160, system 70, steal 170, iowait 100, idle 500.
  const round = (value) => Math.round(value * 10) / 10;
  assert.equal(round(usage.userPercent), 16);
  assert.equal(round(usage.systemPercent), 7);
  assert.equal(round(usage.stealPercent), 17);
  assert.equal(round(usage.iowaitPercent), 10);
  assert.equal(round(usage.busyPercent), 40);
  // cpu0: Δtotal 250, Δbusy 160 → 64%; cpu2: Δtotal 500, Δbusy 60 → 12%; cpu3 is new.
  assert.deepEqual(
    usage.perCore.map((core) => [core.id, round(core.busyPercent)]),
    [
      [0, 64],
      [2, 12],
      [3, 0],
    ],
  );
});

test("the disk is the mount holding home, with df's rounding", () => {
  const mounts = "/dev/root / ext4 rw 0 0\n/dev/sdb1 /home ext4 rw 0 0\n/dev/sdc1 /home2 ext4 rw 0 0\nnone /mnt/my\\040disk ext4 rw 0 0\n";
  assert.equal(mountPointFor(mounts, "/home/me"), "/home");
  assert.equal(mountPointFor(mounts, "/home2x/me"), "/");
  assert.equal(mountPointFor(mounts, "/mnt/my disk/me"), "/mnt/my disk");
  // 1000 blocks, 100 free of which 50 usable: used 900, df Use% = ceil(900 / 950).
  assert.deepEqual(diskFrom({ bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 }, "/"), {
    mountedOn: "/",
    totalBytes: 1000 * 4096,
    usedBytes: 900 * 4096,
    freeBytes: 50 * 4096,
    usedPercent: 95,
  });
});

test("power reports none without supplies, and battery time from energy over draw", () => {
  assert.equal(buildPower([]).source, "none");
  const discharging = buildPower([
    { type: "Mains", online: "0" },
    { type: "Battery", present: "1", status: "Discharging", capacity: "54", energy_now: "30000000", power_now: "10000000" },
  ]);
  assert.deepEqual(discharging, { source: "battery", percent: 54, state: "discharging", timeRemainingMinutes: 180 });
  const charging = buildPower([
    { type: "Mains", online: "1" },
    { type: "Battery", status: "Charging", capacity: "50", charge_now: "2000000", charge_full: "4000000", current_now: "1000000" },
  ]);
  assert.deepEqual(charging, { source: "ac", percent: 50, state: "charging", timeRemainingMinutes: 120 });
  assert.equal(buildPower([{ type: "Mains", online: "1" }]).source, "ac");
});

test("thermal level comes from the hottest zone's own trip points", () => {
  assert.deepEqual(buildThermal([]), { level: "unknown", celsius: null, zone: null });
  assert.deepEqual(buildThermal([{ type: "soc", temp: 51234, trips: [] }]), { level: "unknown", celsius: 51.2, zone: "soc" });
  const trips = [
    { type: "passive", temp: 85000 },
    { type: "hot", temp: 95000 },
    { type: "critical", temp: 105000 },
  ];
  const level = (temp) => buildThermal([{ type: "x86_pkg_temp", temp, trips }, { type: "acpitz", temp: 30000, trips: [] }]).level;
  assert.equal(level(60000), "nominal");
  assert.equal(level(85000), "fair");
  assert.equal(level(96000), "serious");
  assert.equal(level(105000), "critical");
});

test("/proc/<pid>/stat names may contain spaces and parentheses", () => {
  const line = "4242 (tmux: server (1)) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 12345 1000000 256 18446744073709551615 0 0 0 0 0 0 0 0 0";
  assert.deepEqual(parseProcStat(line, 4096), {
    pid: 4242,
    ppid: 1,
    ticks: 200,
    startTicks: 12345,
    rssBytes: 256 * 4096,
    comm: "tmux: server (1)",
  });
  assert.equal(parseProcStat("garbage", 4096), null);
});

test("commands keep the name a launcher chose and fall back to the executable path", () => {
  // Claude's executable is a versioned file; argv[0] says what it is.
  assert.equal(
    commandFrom("/home/me/.local/bin/claude", "/home/me/.local/share/claude/versions/2.1.307", "claude"),
    "/home/me/.local/bin/claude",
  );
  assert.equal(commandFrom("python3", "/home/me/app/.venv/bin/python3", "python3"), "/home/me/app/.venv/bin/python3");
  assert.equal(commandFrom("Paseo Daemon", "/usr/bin/node", "node-MainThread"), "Paseo Daemon");
  assert.equal(commandFrom("node", null, "node-MainThread"), "node");
  assert.equal(commandFrom("", null, "kworker/3:1H"), "[kworker/3:1H]");
  assert.equal(commandFrom("chrome --type=renderer --lang=en-US", "/usr/lib/chromium/chromium", "chrome"), "chrome");
  assert.equal(commandFrom("/usr/lib/chromium/chromium --type=zygote", "/usr/lib/chromium/chromium", "chromium"), "/usr/lib/chromium/chromium");
  assert.equal(commandFrom("postgres: checkpointer", null, "postgres"), "postgres: checkpointer");
});

test("process CPU is measured between samples, and a reused PID starts from zero", () => {
  const previous = { at: 0, table: [{ pid: 1, ticks: 100, startTicks: 5 }, { pid: 2, ticks: 50, startTicks: 7 }] };
  const current = { at: 2000, table: [{ pid: 1, ticks: 400, startTicks: 5 }, { pid: 2, ticks: 900, startTicks: 99 }, { pid: 3, ticks: 10, startTicks: 100 }] };
  const cpu = cpuBetween(previous, current, 100);
  assert.equal(cpu.get(1), 150);
  assert.equal(cpu.get(2), 0);
  assert.equal(cpu.get(3), 0);
  assert.equal(formatElapsed(59), "00:59");
  assert.equal(formatElapsed(3_725), "01:02:05");
  assert.equal(formatElapsed(90_061), "1-01:01:01");
});

test("ss listeners keep owners with spaces in their names and drop interface suffixes", () => {
  const raw = [
    'tcp   LISTEN 0      511                               0.0.0.0:6767       0.0.0.0:*    users:(("Paseo Daemon",pid=3413068,fd=31))',
    'tcp   LISTEN 0      4096                        127.0.0.53%lo:53         0.0.0.0:*',
    'tcp   LISTEN 0      128                                  [::]:22            [::]:*',
    'tcp   LISTEN 0      511                                     *:5173             *:*    users:(("node",pid=10,fd=20),("node",pid=11,fd=20))',
    'udp   UNCONN 0      0                     [fe80::1%eth0]:546            [::]:*',
  ].join("\n");
  assert.deepEqual(parseSsListeners(raw), [
    { protocol: "tcp", address: "0.0.0.0", port: 6767, pid: 3413068, command: "Paseo Daemon" },
    { protocol: "tcp", address: "127.0.0.53", port: 53, pid: null, command: null },
    { protocol: "tcp", address: "::", port: 22, pid: null, command: null },
    { protocol: "tcp", address: "*", port: 5173, pid: 10, command: "node" },
    { protocol: "udp", address: "fe80::1", port: 546, pid: null, command: null },
  ]);
});

test("scope treats all of 127.0.0.0/8 as loopback", () => {
  assert.equal(scopeOf("127.0.0.53"), "local");
  assert.equal(scopeOf("::ffff:127.0.0.1"), "local");
  assert.equal(scopeOf("::1"), "local");
  assert.equal(scopeOf("*"), "public");
  assert.equal(scopeOf("::"), "public");
  assert.equal(scopeOf("10.0.0.4"), "lan");
});

test("development ports are judged by runtime and path, not port number", () => {
  const home = "/home/me";
  const check = (command, owner = "you") => classifyRelevance({ kind: "process", command, owner, home });
  assert.equal(check("/usr/lib/postgresql/16/bin/postgres"), "dev");
  assert.equal(check("/usr/sbin/sshd"), "system");
  assert.equal(check("[kworker/0:1]"), "system");
  assert.equal(check("/usr/bin/rustdesk"), "system");
  assert.equal(check("/home/me/.cargo/bin/myserver"), "dev");
  assert.equal(check("/usr/bin/node"), "dev");
  assert.equal(check("/usr/bin/node", "other"), "system");
});

test("agent lists from Paseo 0.12 are unwrapped from their entries", () => {
  const agents = normalizeAgents({
    requestId: "r",
    entries: [{ agent: { id: "a1", provider: "codex/gpt-5", cwd: "/repo", title: "Fix" } }, { agent: { id: "a2" } }],
    pageInfo: {},
  });
  assert.deepEqual(agents, [{ id: "a1", provider: "codex", cwd: "/repo", title: "Fix", status: "" }]);
});

test("kernel threads are described by their family", () => {
  assert.equal(describeKnown("[kworker/3:1H]")?.what, "a kernel worker thread");
  assert.equal(describeKnown("jbd2/sda1-8")?.what, "the ext4 journal writer");
  assert.equal(describeKnown("kswapd0")?.trigger?.includes("memory"), true);
  assert.equal(describeKnown("myapp"), null);
});

test("agents are matched by provider and cwd, and a Codex app-server in the daemon's cwd still counts", () => {
  const child = (pid, command, cwd) => ({ pid, ppid: 1, ticks: 0, startTicks: 0, rssBytes: 0, comm: "", command, cwd });
  const agents = [
    { id: "c1", provider: "claude", cwd: "/repo/a", title: "Claude A" },
    { id: "c2", provider: "claude", cwd: "/repo/b", title: "Claude B" },
    { id: "x1", provider: "codex", cwd: "/repo/a", title: "Codex A" },
  ];
  const roots = matchAgentRoots(
    [
      child(10, "/home/me/.local/bin/claude", "/repo/b"),
      child(11, "/home/me/.local/bin/codex", "/home/me"),
      child(12, "/usr/bin/esbuild", "/home/me"),
      child(13, "/home/me/.local/bin/claudette", "/repo/a"),
      child(14, "/usr/bin/node", "/home/me"),
    ],
    agents,
    new Set([14]),
  );
  assert.deepEqual(
    roots.map((root) => [root.pid, root.provider, root.title, root.cwd]),
    [
      [10, "claude", "Claude B", "/repo/b"],
      [11, "codex", "", ""],
    ],
  );
});
