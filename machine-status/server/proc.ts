import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * Linux process table straight from /proc. Reading a few hundred small procfs
 * files costs a few milliseconds, which is far cheaper than starting `ps`, and
 * the plugin runs in its own process, so the synchronous reads block nothing else.
 */

export interface RawProcess {
  pid: number;
  ppid: number;
  /** utime + stime, in clock ticks. */
  ticks: number;
  /** Start time after boot, in clock ticks. */
  startTicks: number;
  rssBytes: number;
  /** The kernel's 15-character name; Node renames its main thread to node-MainThread. */
  comm: string;
}

let constants: { clockTicks: number; pageSize: number } | null = null;

/** Clock ticks per second and page size, asked once; arm64 kernels can use 16 KiB or 64 KiB pages. */
export function procConstants(): { clockTicks: number; pageSize: number } {
  if (constants) return constants;
  const ask = (name: string, fallback: number): number => {
    try {
      const value = Number(execFileSync("getconf", [name], { encoding: "utf8", timeout: 2_000 }).trim());
      return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  };
  constants = { clockTicks: ask("CLK_TCK", 100), pageSize: ask("PAGESIZE", 4096) };
  return constants;
}

/**
 * Reads one `/proc/<pid>/stat` line. The name sits in parentheses and may itself
 * contain spaces and parentheses, so the fields are counted from the last `)`.
 */
export function parseProcStat(raw: string, pageSize: number): RawProcess | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(raw.slice(0, open).trim());
  const fields = raw.slice(close + 2).trim().split(" ");
  // fields[0] is field 3 (state); utime is field 14, stime 15, starttime 22, rss 24.
  const ppid = Number(fields[1]);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const startTicks = Number(fields[19]);
  const rssPages = Number(fields[21]);
  if (!Number.isInteger(pid) || !Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
  return {
    pid,
    ppid,
    ticks,
    startTicks: Number.isFinite(startTicks) ? startTicks : 0,
    rssBytes: Number.isFinite(rssPages) ? Math.max(0, rssPages) * pageSize : 0,
    comm: raw.slice(open + 1, close),
  };
}

export function readProcTable(): RawProcess[] {
  const { pageSize } = procConstants();
  const table: RawProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (entry.charCodeAt(0) < 48 || entry.charCodeAt(0) > 57) continue;
    try {
      const parsed = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf8"), pageSize);
      if (parsed) table.push(parsed);
    } catch {
      // Exited between the directory listing and the read.
    }
  }
  return table;
}

/**
 * What a person would call the process. argv[0] keeps names a launcher chose
 * (`claude`, `Paseo Daemon`, `postgres: checkpointer`) where the executable is a
 * versioned file or a shared runtime; kernel threads have no argv and get the
 * bracketed name `ps` shows. The executable path stands in when argv[0] is bare,
 * because the path is what separates /usr/sbin/... from ~/.venv/bin/python.
 */
export function commandFrom(rawArgv0: string, exe: string | null, comm: string): string {
  // Chromium and others rewrite their title into one argv[0] holding every flag.
  const argv0 = rawArgv0.replace(/ --?[A-Za-z].*$/, "");
  if (argv0.length === 0) return exe ?? `[${comm}]`;
  if (argv0.startsWith("/") || exe === null) return argv0;
  const base = argv0.split("/").pop() ?? argv0;
  return exe.endsWith(`/${base}`) ? exe : argv0;
}

export function commandOf(pid: number, comm: string): string {
  let argv0 = "";
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const end = raw.indexOf("\0");
    argv0 = (end < 0 ? raw : raw.slice(0, end)).trim();
  } catch {
    return `[${comm}]`;
  }
  let exe: string | null = null;
  try {
    exe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    // Other users' processes hide their executable; argv[0] is still readable.
  }
  return commandFrom(argv0, exe, comm);
}

/** Empty when the directory is not readable, which it is not for other users' processes. */
export function cwdOf(pid: number): string {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

export function uptimeSeconds(): number {
  try {
    return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) || 0;
  } catch {
    return 0;
  }
}

/** `ps`-style elapsed time: `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS`. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (days > 0) return `${days}-${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

/* -------------------------------------------------------------------------- */
/* CPU sampling                                                                 */
/* -------------------------------------------------------------------------- */

export interface Sample {
  at: number;
  table: RawProcess[];
}

/**
 * CPU% per process over the interval between two samples, in `top`'s unit: 100
 * is one full core. `ps` would report the lifetime average instead, which hides
 * a process that just started spinning.
 */
export function cpuBetween(previous: Sample, current: Sample, clockTicks: number): Map<number, number> {
  const seconds = (current.at - previous.at) / 1000;
  const before = new Map(previous.table.map((entry) => [entry.pid, entry]));
  const cpu = new Map<number, number>();
  for (const entry of current.table) {
    const old = before.get(entry.pid);
    // A reused PID shows up as a different start time; count it from zero.
    const base = old && old.startTicks === entry.startTicks ? old.ticks : null;
    cpu.set(
      entry.pid,
      base === null || seconds <= 0 ? 0 : Math.max(0, ((entry.ticks - base) / clockTicks / seconds) * 100),
    );
  }
  return cpu;
}

const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 30_000;
const FIRST_WINDOW_MS = 250;

let last: Sample | null = null;
let lastResult: { at: number; table: RawProcess[]; cpu: Map<number, number> } | null = null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let pending: Promise<{ table: RawProcess[]; cpu: Map<number, number> }> | null = null;

/**
 * The process table with CPU% measured since the previous call. Polls are a few
 * seconds apart, so the previous call is the baseline and nothing waits; only a
 * first or stale call takes a short second sample. Calls within a second of the
 * last one share its result, so the card and the tab polling together do not
 * measure over a few milliseconds.
 */
export function sampleProcesses(): Promise<{ table: RawProcess[]; cpu: Map<number, number> }> {
  if (lastResult && Date.now() - lastResult.at < MIN_WINDOW_MS) return Promise.resolve(lastResult);
  pending ??= measure().finally(() => {
    pending = null;
  });
  return pending;
}

async function measure(): Promise<{ table: RawProcess[]; cpu: Map<number, number> }> {
  const now = Date.now();
  let previous = last;
  if (!previous || now - previous.at > MAX_WINDOW_MS) {
    previous = { at: Date.now(), table: readProcTable() };
    await wait(FIRST_WINDOW_MS);
  }
  const current: Sample = { at: Date.now(), table: readProcTable() };
  last = current;
  lastResult = { at: current.at, table: current.table, cpu: cpuBetween(previous, current, procConstants().clockTicks) };
  return lastResult;
}
