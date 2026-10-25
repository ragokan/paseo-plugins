import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import type { fitDisplay } from "../shared/contracts.ts";
import { desktopEnvironment } from "./helper.ts";

export type Size = { width: number; height: number };
export type DisplayGeometry = {
  screenWidth: number;
  screenHeight: number;
  workarea: Size & { x: number; y: number };
};
export type FitResult = RpcOutput<typeof fitDisplay>;
export type CommandRunner = (args: string[]) => Promise<string>;

const execute = promisify(execFile);
const virtualName = /^(DUMMY|VIRTUAL|VNC|XVFB)/i;

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "ENOENT") return "xrandr is not installed; it is needed to resize the virtual display.";
    if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) return `xrandr: ${error.stderr.trim()}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export const runXrandr: CommandRunner = async (args) => {
  const result = await execute("xrandr", args, {
    env: { ...desktopEnvironment(), LC_ALL: "C" }, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return result.stdout;
};

export function fitSize(viewer: Size): Size {
  const scale = Math.max(1, 800 / viewer.width, 600 / viewer.height);
  const cap = Math.min(1, 4096 / Math.max(viewer.width * scale, viewer.height * scale));
  // Extreme aspect ratios need the short side clamped to keep both hard bounds.
  return {
    width: Math.max(800, Math.floor(viewer.width * scale * cap / 8) * 8),
    height: Math.max(600, Math.floor(viewer.height * scale * cap / 8) * 8),
  };
}

export function screenSize(target: Size, desktop: DisplayGeometry): Size {
  const horizontal = desktop.screenWidth - desktop.workarea.width;
  const vertical = desktop.screenHeight - desktop.workarea.height;
  if (horizontal < 0 || vertical < 0 || desktop.workarea.width <= 0 || desktop.workarea.height <= 0) {
    throw new Error("The X11 desktop has not reported a valid work area yet.");
  }
  return { width: Math.ceil((target.width + horizontal) / 8) * 8, height: target.height + vertical };
}

export function modeline(size: Size): { name: string; args: string[]; horizontalKHz: number } {
  const { width, height } = size;
  const htotal = width + 160;
  const vtotal = height + 30;
  const clock = (htotal * vtotal * 60 / 1_000_000).toFixed(2);
  const horizontalKHz = Number(clock) * 1000 / htotal;
  if (horizontalKHz >= 1000) throw new Error("The requested display mode exceeds the virtual display's 1000 kHz horizontal frequency limit.");
  const name = `paseo-${width}x${height}`;
  return { name, horizontalKHz, args: [name, clock, String(width), String(width + 48), String(width + 80),
    String(htotal), String(height), String(height + 3), String(height + 8), String(vtotal), "-hsync", "+vsync"] };
}

type Output = Size & { name: string; primary: boolean; mode: string | null; modes: Set<string> };

export function parseXrandr(query: string): { screen: Size; maximum: Size; outputs: Output[]; modes: Set<string> } {
  const screen = query.match(/current (\d+) x (\d+), maximum (\d+) x (\d+)/);
  if (!screen) throw new Error("xrandr did not report the X11 screen size.");
  const outputs: Output[] = [];
  const modes = new Set<string>();
  let output: Output | undefined;
  for (const line of query.split("\n")) {
    const header = line.match(/^(\S+)\s+(connected|disconnected)\b(.*)$/);
    if (header) {
      output = undefined;
      if (header[2] === "connected") {
        const size = header[3].match(/(\d+)x(\d+)[+-]\d+[+-]\d+/);
        output = { name: header[1], primary: /\bprimary\b/.test(header[3]),
          width: Number(size?.[1] ?? 0), height: Number(size?.[2] ?? 0), mode: null, modes: new Set() };
        outputs.push(output);
      }
      continue;
    }
    const mode = line.match(/^\s+(\S+)\s+(.+)$/);
    if (mode && !/^\(/.test(mode[1])) {
      modes.add(mode[1]);
      output?.modes.add(mode[1]);
      if (output && mode[2].includes("*")) output.mode = mode[1];
    }
  }
  return { screen: { width: Number(screen[1]), height: Number(screen[2]) },
    maximum: { width: Number(screen[3]), height: Number(screen[4]) }, outputs, modes };
}

function equal(a: Size | null, b: Size): boolean { return a?.width === b.width && a.height === b.height; }
function success(size: Size): FitResult { return { ok: true, width: size.width, height: size.height, error: null }; }
function failure(error: unknown, size: Size = { width: 0, height: 0 }): FitResult {
  return { ok: false, ...size, error: errorText(error) };
}

/** Owns only modes created here; the original output mode survives failures and idle restores. */
export class DisplayFitter {
  private readonly run: CommandRunner;
  private readonly readDesktop: () => Promise<DisplayGeometry>;
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private operations = 0;
  private stopped = false;
  private stopPromise: Promise<FitResult> | null = null;
  private desired: Size | null = null;
  private revision = 0;
  private waiters: Array<(result: FitResult) => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFrameAt = 0;
  private currentTarget: Size | null = null;
  private original: (Size & { output: string; mode: string; at: number }) | null = null;
  private modes = new Map<string, { output: string; attached: boolean }>();

  constructor(options: {
    run?: CommandRunner;
    readDesktop: () => Promise<DisplayGeometry>;
    onChange?: () => void;
    debounceMs?: number;
    idleMs?: number;
  }) {
    this.run = options.run ?? runXrandr;
    this.readDesktop = options.readDesktop;
    this.onChange = options.onChange ?? (() => {});
    this.debounceMs = options.debounceMs ?? 300;
    this.idleMs = options.idleMs ?? 60_000;
  }

  frameRead(): void {
    this.lastFrameAt = Date.now();
    if (!this.stopped) this.armIdle();
  }

  fit(viewer: Size): Promise<FitResult> {
    if (this.stopped) return Promise.resolve(failure("The BrowserOS plugin has stopped."));
    const target = fitSize(viewer);
    if (!this.desired && this.operations === 0 && equal(this.currentTarget, target)) return Promise.resolve(success(target));
    this.desired = target;
    const revision = ++this.revision;
    clearTimeout(this.debounceTimer);
    const result = new Promise<FitResult>((resolve) => this.waiters.push(resolve));
    this.debounceTimer = setTimeout(() => {
      void this.serialize(async () => {
        if (this.stopped || revision !== this.revision || !this.desired) return;
        const latest = this.desired;
        const waiters = this.waiters.splice(0);
        this.desired = null;
        const fitted = await this.apply(latest);
        for (const resolve of waiters) resolve(fitted);
      });
    }, this.debounceMs);
    return result;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    this.operations++;
    const result = this.queue.then(work).finally(() => { this.operations--; });
    this.queue = result.catch(() => {});
    return result;
  }

  private async apply(target: Size): Promise<FitResult> {
    let applied = false;
    try {
      if (equal(this.currentTarget, target)) return success(target);
      const state = parseXrandr(await this.run(["--query"]));
      const output = state.outputs.find((item) => item.primary) ?? state.outputs[0];
      if (!output) throw new Error("xrandr did not find a connected display output.");
      if (!virtualName.test(output.name)) {
        const providers = await this.run(["--listproviders"]);
        const names = [...providers.matchAll(/\bname:\s*([^\n]+)/gi)].map((match) => match[1]);
        if (!names.length || !names.every((name) => /\b(dummy|xvfb|vnc|virtual)\b/i.test(name))) {
          throw new Error(`Only a virtual display can be resized; this one is ${output.name}.`);
        }
      }
      if (!output.mode) throw new Error(`The virtual display ${output.name} has no active mode to restore.`);
      if (this.original && this.original.output !== output.name) throw new Error("The virtual display output changed before its original mode was restored.");
      const size = screenSize(target, await this.readDesktop());
      if (size.width > state.maximum.width || size.height > state.maximum.height) {
        throw new Error(`The requested screen size exceeds xrandr's maximum ${state.maximum.width}x${state.maximum.height}.`);
      }
      if (equal(state.screen, size)) { this.currentTarget = target; return success(target); }
      const mode = modeline(size);
      this.original ??= { output: output.name, mode: output.mode, width: output.width, height: output.height, at: Date.now() };
      // A pre-existing mode can be reused, but it never becomes ours to remove.
      if (!state.modes.has(mode.name)) {
        try {
          await this.run(["--newmode", ...mode.args]);
          this.modes.set(mode.name, { output: output.name, attached: false });
        } catch (error) {
          if (!/already exists|BadName/i.test(errorText(error)) ||
              !parseXrandr(await this.run(["--query"])).modes.has(mode.name)) throw error;
        }
      }
      if (!output.modes.has(mode.name)) {
        await this.run(["--addmode", output.name, mode.name]);
        const owned = this.modes.get(mode.name);
        if (owned) owned.attached = true;
      }
      await this.run(["--output", output.name, "--mode", mode.name]);
      this.currentTarget = target;
      applied = true;
      this.onChange();
      await this.removeModes(mode.name);
      return success(target);
    } catch (error) {
      return failure(error, applied ? target : undefined);
    } finally {
      this.armIdle();
    }
  }

  private async removeModes(current: string): Promise<void> {
    const errors: string[] = [];
    for (const [name, mode] of this.modes) {
      if (name === current) continue;
      try {
        if (mode.attached) {
          await this.run(["--delmode", mode.output, name]);
          mode.attached = false;
        }
        await this.run(["--rmmode", name]);
        this.modes.delete(name);
      } catch (error) { errors.push(errorText(error)); }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  private idleDeadline(): number { return (this.lastFrameAt || this.original?.at || 0) + this.idleMs; }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.original || this.stopped) return;
    this.idleTimer = setTimeout(() => {
      void this.serialize(async () => {
        if (this.stopped || !this.original) return;
        // A frame may have arrived while this restore waited for an xrandr operation.
        if (Date.now() < this.idleDeadline()) { this.armIdle(); return; }
        const result = await this.restore();
        if (!result.ok) console.error(`BrowserOS display restore failed: ${result.error}`);
      });
    }, Math.max(0, this.idleDeadline() - Date.now()));
    this.idleTimer.unref();
  }

  private async restore(): Promise<FitResult> {
    clearTimeout(this.idleTimer);
    if (!this.original) return success({ width: 0, height: 0 });
    try {
      const original = this.original;
      await this.run(["--output", original.output, "--mode", original.mode]);
      this.currentTarget = null;
      this.onChange();
      await this.removeModes(original.mode);
      this.original = null;
      return success(original);
    } catch (error) { return failure(error, this.currentTarget ?? undefined); }
  }

  stop(): Promise<FitResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.idleTimer);
    this.revision++;
    this.desired = null;
    for (const resolve of this.waiters.splice(0)) resolve(failure("The BrowserOS plugin has stopped."));
    this.stopPromise = this.serialize(() => this.restore());
    return this.stopPromise;
  }
}
