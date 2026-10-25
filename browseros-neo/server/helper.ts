import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { helperSource } from "./helper-source.ts";

export function desktopEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    XAUTHORITY: process.env.XAUTHORITY || join(homedir(), ".Xauthority"),
    GDK_BACKEND: "x11",
  };
}

export interface HelperTransport {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  stop(): Promise<void>;
}

/** One sequential stream also makes input batches atomic, including across RPC callers. */
export class DesktopHelper implements HelperTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | null = null;
  private stderr = "";
  private readonly idleMs: number;

  constructor(idleMs = 30_000) { this.idleMs = idleMs; }

  request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const result = this.queue.then(() => this.perform<T>(method, params, timeoutMs));
    this.queue = result.catch(() => {});
    return result;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    this.stderr = "";
    const child = spawn("python3", ["-u", "-c", helperSource], {
      env: desktopEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-2000);
    });
    lines.on("line", (line) => {
      if (this.child !== child) return;
      try {
        const message = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        if (this.pending?.id !== message.id) return;
        if (message.error) this.pending.reject(new Error(message.error));
        else this.pending.resolve(message.result);
      } catch {
        this.fail(child, new Error("The BrowserOS desktop helper returned invalid JSON."));
      }
    });
    child.on("error", (error) => this.fail(child, new Error(`Could not start Python 3: ${error.message}`)));
    child.stdin.on("error", (error) => this.fail(child, error));
    child.on("exit", (code, signal) => {
      this.fail(child, new Error(`The BrowserOS desktop helper exited (${signal ?? code}). ${this.stderr}`.trim()));
      lines.close();
    });
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.pending?.reject(error);
    child.kill();
  }

  private async perform<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.stopped) throw new Error("The BrowserOS plugin has stopped.");
    clearTimeout(this.idleTimer);
    const child = this.start();
    const id = ++this.sequence;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending = { id, resolve: (value) => resolve(value as T), reject };
        timeout = setTimeout(() => {
          this.fail(child, new Error("The BrowserOS desktop helper timed out."));
        }, timeoutMs);
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
          if (error) this.fail(child, error);
        });
      });
    } finally {
      clearTimeout(timeout);
      this.pending = null;
      if (!this.stopped && this.child) {
        this.idleTimer = setTimeout(() => {
          if (this.child === child) {
            this.child = null;
            child.stdin.end();
            child.kill();
          }
        }, this.idleMs);
        this.idleTimer.unref();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (child) {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      this.fail(child, new Error("The BrowserOS plugin has stopped."));
      await exited;
    }
    await this.queue;
  }
}
