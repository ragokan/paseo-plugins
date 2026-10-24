import os from "node:os";
import type { z } from "zod";
import type { MetricsSchema } from "../shared/contracts.ts";
import { parseSocketAddress } from "../shared/services-classify.ts";
import { binary, run, runTolerant, tryRun } from "./exec.ts";
import type { RawProcess } from "./proc.ts";
import type { Listener } from "./services.ts";

type Metrics = z.output<typeof MetricsSchema>;
type Memory = Metrics["memory"];
type Swap = Metrics["swap"];
type Power = Metrics["power"];
type Thermal = Metrics["thermal"];

/**
 * macOS has no /proc, so everything here comes from the tools it ships: vm_stat,
 * sysctl and pmset for the machine, ps for processes, lsof and netstat for
 * sockets. Each poll starts a few of them, and only while the Machine screen is
 * on screen.
 */

/* -------------------------------------------------------------------------- */
/* Parsers: pure functions over captured output, covered by tests             */
/* -------------------------------------------------------------------------- */

export interface VmStat {
  pageSize: number;
  pages: Record<string, number>;
}

/**
 * `vm_stat` prints "Key:  12345." lines, a few keys in quotes. The page size is
 * only in the header, and it is 16 KiB on Apple Silicon.
 */
export function parseVmStat(raw: string): VmStat {
  const header = /page size of (\d+) bytes/.exec(raw);
  const pages: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line);
    if (match) pages[match[1]!.trim().toLowerCase()] = Number(match[2]);
  }
  return { pageSize: header ? Number(header[1]) : 4096, pages };
}

/** `sysctl name1 name2` prints `name: value` lines. */
export function parseSysctl(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 2).trim();
  }
  return values;
}

const PRESSURE: Record<string, Memory["pressure"]> = { "1": "normal", "2": "warning", "4": "critical" };

/**
 * Activity Monitor's figures: App memory is anonymous memory less what apps
 * marked purgeable, and in use is app, wired and compressed memory together.
 * Cached files are what macOS drops on demand.
 */
export function buildMacMemory(vm: VmStat, totalBytes: number, pressureLevel: string | undefined): Memory {
  const bytes = (key: string): number => (vm.pages[key] ?? 0) * vm.pageSize;
  const appBytes = Math.max(0, bytes("anonymous pages") - bytes("pages purgeable"));
  const kernelBytes = bytes("pages wired down");
  const compressedBytes = bytes("pages occupied by compressor");
  const usedBytes = Math.min(totalBytes, appBytes + kernelBytes + compressedBytes);
  return {
    totalBytes,
    availableBytes: Math.max(0, totalBytes - usedBytes),
    usedBytes,
    appBytes,
    sharedBytes: 0,
    kernelBytes,
    compressedBytes,
    cachedBytes: bytes("file-backed pages") + bytes("pages purgeable"),
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    stallPercent: null,
    pressure: (pressureLevel !== undefined ? PRESSURE[pressureLevel] : undefined) ?? null,
  };
}

const SIZE: Record<string, number> = { "": 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `total = 2048.00M  used = 1187.94M  free = 860.06M  (encrypted)`, from `sysctl vm.swapusage`. */
export function parseSwapUsage(raw: string): Swap {
  const field = (key: string): number => {
    const match = new RegExp(`${key}\\s*=\\s*([\\d.]+)\\s*([BKMGT]?)`, "i").exec(raw);
    return match ? Number(match[1]) * (SIZE[match[2]!.toUpperCase()] ?? 1) : 0;
  };
  return { totalBytes: field("total"), usedBytes: field("used"), freeBytes: field("free") };
}

/**
 * `pmset -g batt`: the source, then one line per battery,
 * ` -InternalBattery-0 (id=…)\t62%; charging; 1:44 remaining present: true`.
 * A Mac without a battery prints the source alone.
 */
export function parseBattery(raw: string): Power {
  const drawing = /Now drawing from '([^']+)'/i.exec(raw);
  const source: Power["source"] = !drawing ? "unknown" : /ac power/i.test(drawing[1]!) ? "ac" : "battery";
  const battery = /\t(\d+)%;\s*([^;\n]*)/.exec(raw);
  const time = /(\d+):(\d{2}) remaining/.exec(raw);
  return {
    source,
    percent: battery ? Number(battery[1]) : null,
    state: battery ? battery[2]!.trim().toLowerCase() || null : null,
    timeRemainingMinutes: time ? Number(time[1]) * 60 + Number(time[2]) : null,
  };
}

/**
 * `pmset -g therm`. Intel Macs report a CPU speed limit; Apple Silicon reports
 * that no thermal warning has been raised, which is the normal state. Anything
 * else is not reported rather than guessed.
 */
export function parseMacThermal(raw: string): Thermal {
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(raw);
  if (limit) {
    const percent = Number(limit[1]);
    const level: Thermal["level"] = percent >= 100 ? "nominal" : percent >= 75 ? "fair" : percent >= 50 ? "serious" : "critical";
    return { level, celsius: null, zone: null };
  }
  if (/No thermal warning level has been recorded/i.test(raw)) return { level: "nominal", celsius: null, zone: null };
  return { level: "unknown", celsius: null, zone: null };
}

/** ps's `time`: `[dd-][hh:]mm:ss.cc`, user plus system CPU time. Returns centiseconds. */
export function parseCpuTime(field: string): number {
  const [days, clock] = field.includes("-") ? field.split("-", 2) : ["0", field];
  const parts = clock!.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round((Number(days) * 86_400 + seconds) * 100);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ps's `lstart` in the C locale, `Sat Oct 24 16:39:32 2026`, in local time. Returns epoch seconds. */
export function parseLstart(field: string): number | null {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(field.trim());
  const month = match ? MONTHS.indexOf(match[1]!) : -1;
  if (!match || month < 0) return null;
  const [, , day, hours, minutes, seconds, year] = match.map(Number);
  return new Date(year!, month, day, hours, minutes, seconds).getTime() / 1000;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*?)\s*$/;

/**
 * `ps -axww -o pid=,ppid=,rss=,time=,lstart=,comm=`, comm last because it can
 * hold spaces. It is the process's argv[0], so a path when one was used and the
 * title a process gave itself (`Paseo Daemon`) otherwise. CPU time counts in
 * centiseconds, and the start time, from boot, tells a reused PID apart.
 */
export function parsePsTable(raw: string, bootSeconds: number): RawProcess[] {
  const table: RawProcess[] = [];
  for (const line of raw.split("\n")) {
    const match = PS_LINE.exec(line);
    const started = match ? parseLstart(match[5]!) : null;
    if (!match) continue;
    table.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ticks: parseCpuTime(match[4]!),
      startTicks: started === null ? 0 : Math.round((started - bootSeconds) * CLOCK_TICKS),
      rssBytes: Number(match[3]) * 1024,
      comm: match[6]!,
    });
  }
  return table;
}

/** `lsof -F` output: `p` opens a process, then its files' `f` and `n` lines. */
export function parseLsofNames(raw: string): Map<number, string[]> {
  const names = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (!names.has(pid)) names.set(pid, []);
    } else if (line.startsWith("n") && pid !== null) {
      names.get(pid)!.push(line.slice(1));
    }
  }
  return names;
}

/**
 * `lsof -i… +c 0 -Fpcn`: `p` and `c` name the process, then one `n` per
 * socket. Connected sockets (`a->b`) and unbound ones (`*:*`) are not listeners.
 */
export function parseLsofSockets(raw: string, protocol: "tcp" | "udp"): Listener[] {
  const sockets: Listener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of raw.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      pid = Number(value);
      command = null;
    } else if (line.startsWith("c")) {
      command = value;
    } else if (line.startsWith("n") && pid !== null && !value.includes("->")) {
      const parsed = parseSocketAddress(value);
      if (parsed) sockets.push({ protocol, ...parsed, pid, command });
    }
  }
  return sockets;
}

/**
 * `netstat -an` lists every socket, other users' too, as
 * `tcp4  0  0  127.0.0.1.5432  *.*  LISTEN`, the port after the last dot; the
 * other sections hold no `tcp`/`udp` lines. It shortens long IPv6 addresses, so a
 * socket lsof can see is matched by port as well.
 */
export function parseNetstatListeners(raw: string): Omit<Listener, "pid" | "command">[] {
  const listeners: Omit<Listener, "pid" | "command">[] = [];
  for (const line of raw.split("\n")) {
    const match = /^(tcp|udp)\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s*(\S*)\s*$/.exec(line);
    if (!match) continue;
    const [, protocol, local, foreign, state] = match;
    if (protocol === "tcp" ? state !== "LISTEN" : foreign !== "*.*") continue;
    const at = local!.lastIndexOf(".");
    const port = Number(local!.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) continue;
    listeners.push({ protocol: protocol as "tcp" | "udp", address: local!.slice(0, at), port });
  }
  return listeners;
}

/** The sockets lsof attributes, then the ones only netstat sees, which belong to other users. */
export function mergeListeners(own: readonly Listener[], all: readonly Omit<Listener, "pid" | "command">[]): Listener[] {
  const key = (entry: { protocol: string; address: string; port: number }) => `${entry.protocol}:${entry.address}:${entry.port}`;
  const ownKeys = new Set(own.map(key));
  const ownPorts = new Set(own.map((entry) => `${entry.protocol}:${entry.port}`));
  const others = all.filter((entry) => !ownKeys.has(key(entry)) && !ownPorts.has(`${entry.protocol}:${entry.port}`));
  return [...own, ...others.map((entry) => ({ ...entry, pid: null, command: null }))];
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                      */
/* -------------------------------------------------------------------------- */

/** ps's `time` has centiseconds. */
export const CLOCK_TICKS = 100;

// Boot time, fixed once, so the same process keeps the same start from one read to the next.
let bootSeconds: number | null = null;

export async function readMacProcTable(): Promise<RawProcess[]> {
  bootSeconds ??= Math.round(Date.now() / 1000 - os.uptime());
  const raw = await run(binary("ps"), ["-axww", "-o", "pid=,ppid=,rss=,time=,lstart=,comm="], 10_000);
  return parsePsTable(raw, bootSeconds);
}

/** The working directory of each process this user may inspect, in one lsof call. */
export async function readMacCwds(pids: readonly number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  const raw = await runTolerant(binary("lsof"), ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], 5_000);
  for (const [pid, names] of parseLsofNames(raw)) if (names[0]) cwds.set(pid, names[0]);
  return cwds;
}

/** ps prints nothing for a PID that is gone, and `Z…` for a zombie. */
export async function macProcessRunning(pid: number): Promise<boolean> {
  const state = (await tryRun(binary("ps"), ["-o", "stat=", "-p", String(pid)], 3_000))?.trim();
  return Boolean(state) && !state!.startsWith("Z");
}

export async function macUidOf(pid: number): Promise<number | null> {
  const uid = (await tryRun(binary("ps"), ["-o", "uid=", "-p", String(pid)], 3_000))?.trim();
  return uid ? Number(uid) : null;
}

/**
 * This user's listeners from lsof, and everyone else's from netstat. macOS
 * hides internet sockets from netstat for some parent processes (Node started
 * from a shell, for one), so `othersHidden` says when it listed none at all.
 */
export async function readMacListeners(): Promise<{ listeners: Listener[]; othersHidden: boolean }> {
  const lsof = binary("lsof");
  const [tcp, udp, everyone] = await Promise.all([
    runTolerant(lsof, ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "+c", "0", "-Fpcn"], 8_000),
    runTolerant(lsof, ["-iUDP", "-P", "-n", "+c", "0", "-Fpcn"], 8_000),
    tryRun(binary("netstat"), ["-an"], 8_000),
  ]);
  const own = [...parseLsofSockets(tcp, "tcp"), ...parseLsofSockets(udp, "udp")];
  const all = parseNetstatListeners(everyone ?? "");
  return { listeners: mergeListeners(own, all), othersHidden: all.length === 0 && own.length > 0 };
}

// Power and thermal state change slowly; pmset is asked at most every 30 s.
const PMSET_TTL_MS = 30_000;
let pmset: { at: number; power: Power; thermal: Thermal } | null = null;
// The volume holding the home directory does not move while the daemon runs.
let homeVolume: Promise<string> | null = null;

/** Where the volume holding `home` is mounted, from df; APFS puts it at /System/Volumes/Data. */
export function macVolumeOf(home: string): Promise<string> {
  homeVolume ??= tryRun(binary("df"), ["-P", home], 5_000).then((raw) => {
    const line = raw?.trim().split("\n")[1];
    return /\d+%\s+(\/.*)$/.exec(line ?? "")?.[1] ?? "/";
  });
  return homeVolume;
}

/** Memory, swap, power and thermal state, as Activity Monitor and System Settings report them. */
export async function readMacMachine(): Promise<Pick<Metrics, "memory" | "swap" | "power" | "thermal">> {
  const fresh = pmset !== null && Date.now() - pmset.at < PMSET_TTL_MS;
  const [vmStat, sysctl, battery, therm] = await Promise.all([
    run(binary("vm_stat"), [], 5_000),
    run(binary("sysctl"), ["kern.memorystatus_vm_pressure_level", "vm.swapusage"], 5_000),
    fresh ? null : tryRun(binary("pmset"), ["-g", "batt"], 5_000),
    fresh ? null : tryRun(binary("pmset"), ["-g", "therm"], 5_000),
  ]);
  if (!fresh) {
    pmset = {
      at: Date.now(),
      power: battery === null ? { source: "unknown", percent: null, state: null, timeRemainingMinutes: null } : parseBattery(battery),
      thermal: therm === null ? { level: "unknown", celsius: null, zone: null } : parseMacThermal(therm),
    };
  }
  const values = parseSysctl(sysctl);
  return {
    memory: buildMacMemory(parseVmStat(vmStat), os.totalmem(), values["kern.memorystatus_vm_pressure_level"]),
    swap: parseSwapUsage(values["vm.swapusage"] ?? ""),
    power: pmset!.power,
    thermal: pmset!.thermal,
  };
}
