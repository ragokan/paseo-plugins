import { readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import type { z } from "zod";
import type { MetricsSchema } from "../shared/contracts.ts";

type Metrics = z.output<typeof MetricsSchema>;
type HistorySample = Metrics["history"][number];
type Power = Metrics["power"];
type Thermal = Metrics["thermal"];
type Disk = Metrics["disk"];
type Swap = Metrics["swap"];

/**
 * Everything here reads /proc, /sys and statfs directly. No metric starts a
 * process, so a poll costs a handful of small file reads.
 */

/* -------------------------------------------------------------------------- */
/* Parsers — pure functions over raw kernel files, covered by tests            */
/* -------------------------------------------------------------------------- */

/** `/proc/meminfo` lines are `Key:   12345 kB`; the result is in bytes. */
export function parseMeminfo(raw: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^([^:]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * (line.trimEnd().endsWith("kB") ? 1024 : 1);
  }
  return values;
}

export function buildMemory(info: Record<string, number>, stallPercent: number | null): Metrics["memory"] {
  const get = (key: string): number => info[key] ?? 0;
  const totalBytes = get("MemTotal");
  // Kernels before 3.14 lack MemAvailable; free plus cache is the old approximation.
  const availableBytes =
    "MemAvailable" in info ? get("MemAvailable") : get("MemFree") + get("Buffers") + get("Cached");
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const sharedBytes = get("Shmem");
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    appBytes: get("AnonPages"),
    sharedBytes,
    kernelBytes: get("SUnreclaim") + get("KernelStack") + get("PageTables") + get("SecPageTables"),
    cachedBytes: Math.max(0, get("Buffers") + get("Cached") + get("SReclaimable") - sharedBytes),
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    stallPercent,
  };
}

export function buildSwap(info: Record<string, number>): Swap {
  const totalBytes = info.SwapTotal ?? 0;
  const freeBytes = info.SwapFree ?? 0;
  return { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), freeBytes };
}

/** `/proc/pressure/*` starts with `some avg10=1.23 avg60=… total=…`. */
export function parsePressure(raw: string): number | null {
  const match = /^some\s+avg10=([\d.]+)/m.exec(raw);
  return match ? Number(match[1]) : null;
}

export interface CpuTimes {
  busy: number;
  total: number;
}

/**
 * The first `/proc/stat` line sums every core. Idle and iowait count as idle;
 * guest time is already inside user and nice, so the last two columns are left out.
 */
export function parseCpuTimes(raw: string): CpuTimes | null {
  const line = raw.split("\n", 1)[0] ?? "";
  if (!line.startsWith("cpu ")) return null;
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return null;
  const total = fields.reduce((sum, value) => sum + value, 0);
  const idle = fields[3] + (fields[4] ?? 0);
  return { busy: total - idle, total };
}

export function busyBetween(previous: CpuTimes, current: CpuTimes): number {
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((current.busy - previous.busy) / total) * 100));
}

/** Picks the mount point that holds `target` from `/proc/self/mounts`. */
export function mountPointFor(mounts: string, target: string): string {
  let best = "/";
  for (const line of mounts.split("\n")) {
    // Spaces in mount points are written as \040.
    const point = line.split(" ")[1]?.replace(/\\040/g, " ");
    if (!point) continue;
    const inside = point === "/" || target === point || target.startsWith(`${point}/`);
    if (inside && point.length > best.length) best = point;
  }
  return best;
}

export function diskFrom(stats: { bsize: number; blocks: number; bfree: number; bavail: number }, mountedOn: string): Disk {
  const totalBytes = stats.blocks * stats.bsize;
  const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  const usable = usedBytes + freeBytes;
  return {
    mountedOn,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: usable > 0 ? Math.ceil((usedBytes / usable) * 100) : 0,
  };
}

/** One `/sys/class/power_supply/<name>` directory, as name → file contents. */
export type SupplyFiles = Record<string, string>;

/**
 * Laptops report a Battery and a Mains (or USB) supply; desktops, servers and VMs
 * usually report nothing, which is `none` rather than a guess. Time remaining comes
 * from energy or charge over the present draw, as upower computes it.
 */
export function buildPower(supplies: readonly SupplyFiles[]): Power {
  const battery = supplies.find((supply) => supply.type === "Battery" && supply.present !== "0");
  const mains = supplies.filter((supply) => supply.type === "Mains" || supply.type?.startsWith("USB"));
  if (!battery && mains.length === 0) {
    return { source: "none", percent: null, state: null, timeRemainingMinutes: null };
  }

  const online = mains.some((supply) => supply.online === "1");
  const source: Power["source"] = online ? "ac" : battery ? "battery" : "unknown";
  if (!battery) return { source, percent: null, state: null, timeRemainingMinutes: null };

  const number = (key: string): number | null => {
    const value = Number(battery[key]);
    return battery[key] !== undefined && Number.isFinite(value) ? value : null;
  };
  const now = number("energy_now") ?? number("charge_now");
  const full = number("energy_full") ?? number("charge_full");
  const rate = Math.abs(number("power_now") ?? number("current_now") ?? 0);
  const state = battery.status ?? null;
  let hours: number | null = null;
  if (rate > 0 && now !== null) {
    if (state === "Discharging") hours = now / rate;
    else if (state === "Charging" && full !== null) hours = Math.max(0, full - now) / rate;
  }

  return {
    source,
    percent: number("capacity"),
    state: state === null ? null : state.toLowerCase(),
    timeRemainingMinutes: hours === null ? null : Math.round(hours * 60),
  };
}

export interface ThermalZone {
  type: string;
  /** Millidegrees Celsius, as the kernel writes them. */
  temp: number;
  trips: { type: string; temp: number }[];
}

/**
 * The hottest zone, judged against its own trip points. Zones without usable trip
 * points report a temperature but no level: a threshold invented here would read
 * as the hardware's.
 */
export function buildThermal(zones: readonly ThermalZone[]): Thermal {
  const valid = zones.filter((zone) => Number.isFinite(zone.temp) && zone.temp > 0);
  if (valid.length === 0) return { level: "unknown", celsius: null, zone: null };
  const hottest = valid.reduce((left, right) => (right.temp > left.temp ? right : left));
  const trip = (type: string): number | null => {
    const temps = hottest.trips.filter((entry) => entry.type === type && entry.temp > 0).map((entry) => entry.temp);
    return temps.length > 0 ? Math.min(...temps) : null;
  };
  const critical = trip("critical");
  const hot = trip("hot");
  const passive = trip("passive");
  const level: Thermal["level"] =
    critical === null && hot === null && passive === null
      ? "unknown"
      : critical !== null && hottest.temp >= critical
        ? "critical"
        : hot !== null && hottest.temp >= hot
          ? "serious"
          : passive !== null && hottest.temp >= passive
            ? "fair"
            : "nominal";
  return { level, celsius: Math.round(hottest.temp / 100) / 10, zone: hottest.type };
}

/* -------------------------------------------------------------------------- */
/* Rolling history                                                              */
/* -------------------------------------------------------------------------- */

export const HISTORY_LIMIT = 90;

/**
 * History accumulates as a side effect of being read. There is deliberately no
 * background timer: a plugin that samples forever would keep the machine busy
 * to report on how busy the machine is. The cost is that history only covers the
 * time something was polling, which is why the chart caption reports the real span
 * between its first and last sample instead of claiming a fixed window.
 */
const history: HistorySample[] = [];

export function appendHistory(sample: HistorySample, limit = HISTORY_LIMIT): HistorySample[] {
  history.push(sample);
  if (history.length > limit) history.splice(0, history.length - limit);
  return history;
}

export function resetHistory(): void {
  history.length = 0;
}

export function toHistorySample(metrics: Omit<Metrics, "history">): HistorySample {
  return {
    at: metrics.collectedAt,
    cpuPercent: metrics.cpu.busyPercent,
    memoryPercent: metrics.memory.usedPercent,
    appBytes: metrics.memory.appBytes,
    sharedBytes: metrics.memory.sharedBytes,
    kernelBytes: metrics.memory.kernelBytes,
    swapUsedBytes: metrics.swap.usedBytes,
  };
}

/* -------------------------------------------------------------------------- */
/* Collector                                                                    */
/* -------------------------------------------------------------------------- */

function read(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readSupplies(): SupplyFiles[] {
  const root = "/sys/class/power_supply";
  return readDir(root).map((name) => {
    const files: SupplyFiles = {};
    for (const key of ["type", "present", "online", "status", "capacity", "energy_now", "energy_full", "charge_now", "charge_full", "power_now", "current_now"]) {
      const value = read(`${root}/${name}/${key}`);
      if (value !== null) files[key] = value.trim();
    }
    return files;
  });
}

function readZones(): ThermalZone[] {
  const root = "/sys/class/thermal";
  return readDir(root)
    .filter((name) => name.startsWith("thermal_zone"))
    .map((name) => {
      const dir = `${root}/${name}`;
      const trips: ThermalZone["trips"] = [];
      for (let index = 0; ; index += 1) {
        const type = read(`${dir}/trip_point_${index}_type`);
        if (type === null) break;
        trips.push({ type: type.trim(), temp: Number(read(`${dir}/trip_point_${index}_temp`)) });
      }
      return { type: read(`${dir}/type`)?.trim() ?? name, temp: Number(read(`${dir}/temp`)), trips };
    });
}

const MIN_CPU_WINDOW_MS = 1_000;
const MAX_CPU_WINDOW_MS = 30_000;
const FIRST_CPU_WINDOW_MS = 100;

let lastCpu: { at: number; times: CpuTimes; busyPercent: number } | null = null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CPU busy since the previous read. Reads closer than a second share the last
 * figure, so two pollers cannot measure over a few milliseconds; a first or stale
 * read takes one short sample instead of reporting the boot-time average.
 */
async function readBusyPercent(): Promise<number> {
  const now = Date.now();
  if (lastCpu && now - lastCpu.at < MIN_CPU_WINDOW_MS) return lastCpu.busyPercent;
  let previous = lastCpu?.times ?? null;
  if (!lastCpu || now - lastCpu.at > MAX_CPU_WINDOW_MS) {
    previous = parseCpuTimes(read("/proc/stat") ?? "");
    await wait(FIRST_CPU_WINDOW_MS);
  }
  const current = parseCpuTimes(read("/proc/stat") ?? "");
  if (!current || !previous) return 0;
  const busyPercent = busyBetween(previous, current);
  lastCpu = { at: Date.now(), times: current, busyPercent };
  return busyPercent;
}

export async function readMetricsHandler(): Promise<Metrics> {
  const snapshot = await collectMetrics();
  return { ...snapshot, history: [...appendHistory(toHistorySample(snapshot))] };
}

/** One reading without touching the chart history. */
export async function collectMetrics(): Promise<Omit<Metrics, "history">> {
  if (process.platform !== "linux") {
    throw new Error(`machine-status reads Linux's /proc; this daemon runs on ${process.platform}.`);
  }

  const busyPercent = await readBusyPercent();
  const meminfo = parseMeminfo(read("/proc/meminfo") ?? "");
  const cpuPressure = read("/proc/pressure/cpu");
  const memoryPressure = read("/proc/pressure/memory");
  const home = os.homedir();
  const cores = os.availableParallelism();
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();

  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSeconds: os.uptime(),
    cpu: {
      cores,
      loadAvg1,
      loadAvg5,
      loadAvg15,
      loadPercent: (loadAvg1 / cores) * 100,
      busyPercent,
      stallPercent: cpuPressure === null ? null : parsePressure(cpuPressure),
    },
    memory: buildMemory(meminfo, memoryPressure === null ? null : parsePressure(memoryPressure)),
    swap: buildSwap(meminfo),
    disk: diskFrom(statfsSync(home), mountPointFor(read("/proc/self/mounts") ?? "", home)),
    power: buildPower(readSupplies()),
    thermal: buildThermal(readZones()),
  };
}
