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
  /** Share of all cores busy since the previous read, from /proc/stat: what `top` calls CPU use. */
  busyPercent: z.number(),
  /** busyPercent split by who used it: user + system + steal = busy. */
  userPercent: z.number(),
  systemPercent: z.number(),
  /** CPU time the hypervisor gave to other guests; only VMs report it. */
  stealPercent: z.number(),
  /** Idle time with disk I/O outstanding. Not part of busy. */
  iowaitPercent: z.number(),
  /** Busy share of each online core over the same interval, by kernel CPU number. */
  perCore: z.array(z.object({ id: z.number(), busyPercent: z.number() })),
  /** PSI: share of the last 10 s in which some task waited for a CPU; null without PSI. */
  stallPercent: z.number().nullable(),
});

export const MemorySchema = z.object({
  totalBytes: z.number(),
  /** The kernel's MemAvailable: free memory plus what it can reclaim without swapping. */
  availableBytes: z.number(),
  /** totalBytes − availableBytes. */
  usedBytes: z.number(),
  /** Anonymous memory processes hold: heaps and stacks. */
  appBytes: z.number(),
  /** tmpfs files and shared memory. `free` counts it as cache, but only swap can reclaim it. */
  sharedBytes: z.number(),
  /** Kernel memory that cannot be reclaimed: unreclaimable slab, kernel stacks and page tables. */
  kernelBytes: z.number(),
  /** Page cache and reclaimable slab, minus shared memory: what the kernel drops on demand. */
  cachedBytes: z.number(),
  usedPercent: z.number(),
  /** PSI: share of the last 10 s in which some task stalled on memory; null without PSI. */
  stallPercent: z.number().nullable(),
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
  /** From the hottest zone's own trip points; `unknown` when it has none or no zone exists. */
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
  swapUsedBytes: z.number(),
});

export const MetricsSchema = z.object({
  collectedAt: z.string(),
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
