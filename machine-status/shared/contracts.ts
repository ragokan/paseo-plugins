import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Every contract in this file is validated on both sides of the plugin boundary:
 * the client validates what it sends, the daemon handler validates what it returns.
 * Keep this module free of Node and React Native code so both bundles can import it.
 */

export const CpuSchema = z.object({
  cores: z.number(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  loadAvg15: z.number(),
  /** loadAvg1 relative to core count, so 100 means "one runnable thread per core". */
  loadPercent: z.number(),
  /** Share of all cores busy since the previous read: what `top` calls CPU use. */
  busyPercent: z.number(),
  /** busyPercent split by who used it: user + system + steal = busy. */
  userPercent: z.number(),
  systemPercent: z.number(),
  /** CPU time the hypervisor gave to other guests; only Linux VMs report it. */
  stealPercent: z.number(),
  /** Idle time with disk I/O outstanding, on Linux. Not part of busy. */
  iowaitPercent: z.number(),
  /** Busy share of each online core over the same interval, by kernel CPU number. */
  perCore: z.array(z.object({ id: z.number(), busyPercent: z.number() })),
  /** PSI: share of the last 10 s in which some task waited for a CPU; null without PSI. */
  stallPercent: z.number().nullable(),
});

export const MemorySchema = z.object({
  totalBytes: z.number(),
  /** Linux: the kernel's MemAvailable, free memory plus what it can reclaim without swapping. macOS: total − used. */
  availableBytes: z.number(),
  /** Linux: totalBytes − availableBytes. macOS: app, wired and compressed memory, as Activity Monitor counts it. */
  usedBytes: z.number(),
  /** Anonymous memory processes hold: heaps and stacks. macOS leaves out what apps marked purgeable. */
  appBytes: z.number(),
  /** Linux: tmpfs files and shared memory. `free` counts it as cache, but only swap can reclaim it. 0 on macOS. */
  sharedBytes: z.number(),
  /** Memory the kernel holds that cannot be reclaimed. Linux: unreclaimable slab, kernel stacks and page tables. macOS: wired memory. */
  kernelBytes: z.number(),
  /** macOS: memory the compressor holds. 0 on Linux. */
  compressedBytes: z.number(),
  /** Linux: page cache and reclaimable slab, minus shared memory. macOS: cached files and purgeable memory. What the system drops on demand. */
  cachedBytes: z.number(),
  usedPercent: z.number(),
  /** Linux PSI: share of the last 10 s in which some task stalled on memory; null without PSI and on macOS. */
  stallPercent: z.number().nullable(),
  /** macOS's memory pressure, as Activity Monitor colors it; null on Linux. */
  pressure: z.enum(["normal", "warning", "critical"]).nullable(),
});

export const SwapSchema = z.object({
  totalBytes: z.number(),
  usedBytes: z.number(),
  freeBytes: z.number(),
});

export const DiskSchema = z.object({
  /** The filesystem holding the home directory, where repositories and caches live. */
  mountedOn: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  /** Free to this user: excludes the blocks ext4 reserves for root. */
  freeBytes: z.number(),
  /** Computed the way df's Use% is: used / (used + available), rounded up. */
  usedPercent: z.number(),
});

export const PowerSchema = z.object({
  /** `none` is a machine with no power supply reported at all: a desktop, server or VM. */
  source: z.enum(["ac", "battery", "none", "unknown"]),
  percent: z.number().nullable(),
  state: z.string().nullable(),
  timeRemainingMinutes: z.number().nullable(),
});

export const ThermalSchema = z.object({
  /**
   * Linux: from the hottest zone's own trip points; `unknown` when it has none or no zone exists.
   * macOS: from pmset, without a temperature.
   */
  level: z.enum(["nominal", "fair", "serious", "critical", "unknown"]),
  celsius: z.number().nullable(),
  zone: z.string().nullable(),
});

/** One point in the rolling history the charts draw. Kept small: it ships on every poll. */
export const HistorySampleSchema = z.object({
  at: z.string(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  appBytes: z.number(),
  sharedBytes: z.number(),
  kernelBytes: z.number(),
  compressedBytes: z.number(),
  swapUsedBytes: z.number(),
});

export const MetricsSchema = z.object({
  collectedAt: z.string(),
  /** Which system the numbers come from; the screen names some of them differently. */
  os: z.enum(["linux", "macos"]),
  hostname: z.string(),
  platform: z.string(),
  uptimeSeconds: z.number(),
  cpu: CpuSchema,
  memory: MemorySchema,
  swap: SwapSchema,
  disk: DiskSchema,
  power: PowerSchema,
  thermal: ThermalSchema,
  history: z.array(HistorySampleSchema),
});

export const readMetrics = defineRpc({
  name: "metrics.read",
  input: z.object({}),
  output: MetricsSchema,
});

export const ProcessSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  name: z.string(),
  command: z.string(),
  /** True when killing this process would take Paseo itself down. */
  guarded: z.boolean(),
});

export const listProcesses = defineRpc({
  name: "processes.list",
  input: z.object({
    sortBy: z.enum(["cpu", "memory"]).default("cpu"),
    limit: z.number().int().min(1).max(50).default(8),
  }),
  output: z.object({
    collectedAt: z.string(),
    items: z.array(ProcessSchema),
  }),
});

export const killProcess = defineRpc({
  name: "processes.kill",
  input: z.object({
    pid: z.number().int().positive(),
    signal: z.enum(["TERM", "KILL"]).default("TERM"),
  }),
  output: z.object({
    ok: z.boolean(),
    pid: z.number(),
    signal: z.string(),
    stillRunning: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type Metrics = z.output<typeof MetricsSchema>;
export type HistorySample = z.output<typeof HistorySampleSchema>;
export type ProcessEntry = z.output<typeof ProcessSchema>;
