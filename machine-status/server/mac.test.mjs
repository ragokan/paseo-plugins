// Pure parsers over captured macOS output; no machine state is read.
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildMacMemory,
  mergeListeners,
  parseBattery,
  parseCpuTime,
  parseLsofNames,
  parseLsofSockets,
  parseLstart,
  parseMacThermal,
  parseNetstatListeners,
  parsePsTable,
  parseSwapUsage,
  parseSysctl,
  parseVmStat,
} = await import("./mac.ts");
const { statFromCpus, usageBetween } = await import("./metrics.ts");

const PAGE = 16384;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   338162.
Pages active:                                 476421.
Pages wired down:                             129126.
Pages purgeable:                               15476.
"Translation faults":                      730219069.
File-backed pages:                            522497.
Anonymous pages:                              436778.
Pages occupied by compressor:                  99702.
`;

test("memory follows Activity Monitor: app less purgeable, plus wired and compressed", () => {
  const vm = parseVmStat(VM_STAT);
  assert.equal(vm.pageSize, PAGE);
  assert.equal(vm.pages["translation faults"], 730219069);
  const total = 24 * 1024 ** 3;
  const memory = buildMacMemory(vm, total, "1");
  assert.equal(memory.appBytes, (436778 - 15476) * PAGE);
  assert.equal(memory.kernelBytes, 129126 * PAGE);
  assert.equal(memory.compressedBytes, 99702 * PAGE);
  assert.equal(memory.usedBytes, (436778 - 15476 + 129126 + 99702) * PAGE);
  assert.equal(memory.availableBytes, total - memory.usedBytes);
  assert.equal(memory.cachedBytes, (522497 + 15476) * PAGE);
  assert.equal(memory.sharedBytes, 0);
  assert.equal(memory.pressure, "normal");
  assert.equal(memory.stallPercent, null);
  assert.equal(buildMacMemory(vm, total, "4").pressure, "critical");
  assert.equal(buildMacMemory(vm, total, undefined).pressure, null);
});

test("sysctl values and swap usage, including none in use", () => {
  const values = parseSysctl(
    "kern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 2048.00M  used = 665.31M  free = 1382.69M  (encrypted)\n",
  );
  assert.equal(values["kern.memorystatus_vm_pressure_level"], "2");
  const swap = parseSwapUsage(values["vm.swapusage"]);
  assert.equal(swap.totalBytes, 2048 * 1024 ** 2);
  assert.equal(swap.usedBytes, 665.31 * 1024 ** 2);
  assert.deepEqual(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"), {
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
  });
});

test("pmset: a MacBook charging, and a Mac mini with no battery", () => {
  assert.deepEqual(
    parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22872163)\t62%; charging; 1:44 remaining present: true\n"),
    { source: "ac", percent: 62, state: "charging", timeRemainingMinutes: 104 },
  );
  assert.deepEqual(
    parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging; (no estimate) present: true\n"),
    { source: "battery", percent: 80, state: "discharging", timeRemainingMinutes: null },
  );
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n"), {
    source: "ac",
    percent: null,
    state: null,
    timeRemainingMinutes: null,
  });
});

test("thermal: no warning is nominal, an Intel speed limit is graded, anything else is not reported", () => {
  const silicon = "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n";
  assert.equal(parseMacThermal(silicon).level, "nominal");
  assert.equal(parseMacThermal("CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 60\n").level, "serious");
  assert.equal(parseMacThermal("").level, "unknown");
  assert.equal(parseMacThermal(silicon).celsius, null);
});

test("ps rows keep comm with spaces, count CPU time in centiseconds, and date the start from boot", () => {
  const raw = [
    "    1     0  19952   4:25.12 Sat Oct 24 08:58:36 2026     /sbin/launchd",
    " 3568  3566 251856  62:38.91 Sat Oct  4 16:41:25 2026     Paseo Daemon",
    " 2517  2496 200912 1-02:03:04.50 Fri Oct 23 09:00:00 2026     /Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo Helper",
    "garbage",
  ].join("\n");
  const boot = new Date(2026, 9, 1, 0, 0, 0).getTime() / 1000;
  const table = parsePsTable(raw, boot);
  assert.equal(table.length, 3);
  assert.deepEqual(table[1], {
    pid: 3568,
    ppid: 3566,
    ticks: (62 * 60 + 38.91) * 100,
    startTicks: (new Date(2026, 9, 4, 16, 41, 25).getTime() / 1000 - boot) * 100,
    rssBytes: 251856 * 1024,
    comm: "Paseo Daemon",
  });
  assert.equal(table[2].comm, "/Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo Helper");
  assert.equal(table[2].ticks, (86_400 + 2 * 3600 + 3 * 60 + 4.5) * 100);
  assert.equal(parseCpuTime("0:00.19"), 19);
  assert.equal(parseLstart("Mon Foo 24 08:58:36 2026"), null);
});

test("lsof: working directories per PID, and listening sockets without connections or unbound ones", () => {
  const cwds = parseLsofNames("p86187\nfcwd\nn/Users/ragokan/coding\np90\nfcwd\nn/\n");
  assert.deepEqual([...cwds], [
    [86187, ["/Users/ragokan/coding"]],
    [90, ["/"]],
  ]);
  const sockets = parseLsofSockets(
    "p714\ncrapportd\nf5\nn*:50176\nf6\nn[::1]:5432\np900\ncnode\nf7\nn127.0.0.1:5173->127.0.0.1:61000\nf8\nn*:*\nf9\nn[fe80::1%lo0]:123\n",
    "tcp",
  );
  assert.deepEqual(sockets, [
    { protocol: "tcp", address: "*", port: 50176, pid: 714, command: "rapportd" },
    { protocol: "tcp", address: "::1", port: 5432, pid: 714, command: "rapportd" },
    { protocol: "tcp", address: "fe80::1", port: 123, pid: 900, command: "node" },
  ]);
});

test("netstat adds other users' listeners lsof cannot see, matched by port when it shortens the address", () => {
  const raw = [
    "Active Internet connections (including servers)",
    "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
    "tcp4       0      0  100.100.5.5.51250      100.100.10.10.4222     ESTABLISHED",
    "tcp6       0      0  *.50176                *.*                    LISTEN",
    "tcp4       0      0  *.22                   *.*                    LISTEN",
    "tcp6       0      0  fd7a:115c:a1e0::.65276 *.*                    LISTEN",
    "udp4       0      0  192.168.1.7.64400      142.251.152.4.443",
    "udp4       0      0  *.5353                 *.*",
    "udp4       0      0  *.*                    *.*",
    "Active LOCAL (UNIX) domain sockets",
    "e25b4bad2cce2a59 stream      0      0                0 e25b4bad2cce2ac1                0                0",
  ].join("\n");
  const all = parseNetstatListeners(raw);
  assert.deepEqual(all, [
    { protocol: "tcp", address: "*", port: 50176 },
    { protocol: "tcp", address: "*", port: 22 },
    { protocol: "tcp", address: "fd7a:115c:a1e0::", port: 65276 },
    { protocol: "udp", address: "*", port: 5353 },
  ]);
  const own = [
    { protocol: "tcp", address: "*", port: 50176, pid: 714, command: "rapportd" },
    { protocol: "tcp", address: "fd7a:115c:a1e0::8b38:3006", port: 65276, pid: 77, command: "tailscaled" },
  ];
  assert.deepEqual(mergeListeners(own, all), [
    ...own,
    { protocol: "tcp", address: "*", port: 22, pid: null, command: null },
    { protocol: "udp", address: "*", port: 5353, pid: null, command: null },
  ]);
});

test("CPU from os.cpus() splits user and system, with no steal or I/O wait", () => {
  const before = statFromCpus([
    { times: { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 } },
    { times: { user: 0, nice: 0, sys: 0, idle: 10000, irq: 0 } },
  ]);
  const after = statFromCpus([
    { times: { user: 1600, nice: 0, sys: 700, idle: 8700, irq: 0 } },
    { times: { user: 100, nice: 0, sys: 0, idle: 10900, irq: 0 } },
  ]);
  const usage = usageBetween(before, after);
  assert.equal(usage.busyPercent, 45);
  assert.equal(usage.userPercent, 35);
  assert.equal(usage.systemPercent, 10);
  assert.equal(usage.stealPercent, 0);
  assert.equal(usage.iowaitPercent, 0);
  assert.deepEqual(usage.perCore, [
    { id: 0, busyPercent: 80 },
    { id: 1, busyPercent: 10 },
  ]);
  assert.equal(statFromCpus([]), null);
});
