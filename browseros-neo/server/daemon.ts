import { performance } from "node:perf_hooks";
import type { RpcInput } from "@getpaseo/plugin";
import { readFrame } from "../shared/contracts.ts";
import type { Frame } from "../shared/contracts.ts";
import { createBackend, unavailable, type BrowserBackend, type CaptureInput } from "./backend.ts";

type FrameInput = RpcInput<typeof readFrame>;

export class BrowserDaemon {
  private stopped = false;
  private captures = new Map<string, { at: number; result: Promise<Frame>; pending: boolean }>();
  private defaultWindow: string | null = null;
  private waits = new Set<() => void>();
  private readonly backend: BrowserBackend;

  constructor(backend?: BrowserBackend) {
    this.backend = backend ?? createBackend(process.platform, () => this.captures.clear());
  }

  private async capture(input: CaptureInput): Promise<Frame> {
    const key = JSON.stringify([input.windowId ?? this.defaultWindow, input.maxWidth, input.maxHeight, input.quality, input.lossless ?? false]);
    const existing = this.captures.get(key);
    if (existing && (existing.pending || performance.now() - existing.at < 60)) {
      const shared = await existing.result;
      // A recent capture is useful only if this viewer has not received it.
      if (shared.hash !== input.since) return shared;
      // Another caller may already have started the fresh capture while this
      // one awaited the old result. Join that capture and check its id too.
      if (this.captures.get(key) !== existing) return this.capture(input);
    }
    const entry = { at: performance.now(), pending: true, result: Promise.resolve(null as unknown as Frame) };
    entry.result = (async () => {
      const previous = await existing?.result;
      let frame = await this.backend.capture({
        ...input, since: input.since ?? previous?.hash ?? null,
        includeImage: !previous?.image || (input.since !== null && input.since !== previous.hash),
      });
      // The helper omits unchanged image bytes. Keep them here so a new viewer
      // sharing this capture can still receive the image it does not have yet.
      if (frame.image === null && frame.hash && frame.hash === previous?.hash) {
        frame = { ...frame, image: previous.image };
      }
      this.defaultWindow = frame.windows[0]?.id ?? null;
      if (input.windowId === null && frame.windowId && this.captures.get(key) === entry) {
        const resolvedKey = JSON.stringify([frame.windowId, input.maxWidth, input.maxHeight, input.quality, input.lossless ?? false]);
        this.captures.set(resolvedKey, entry);
      }
      return frame;
    })().catch(unavailable).finally(() => {
      entry.pending = false;
      entry.at = performance.now();
    });
    // Bound retained base64 frames when viewers repeatedly resize or switch windows.
    for (const [oldKey, old] of this.captures) {
      if (!old.pending && performance.now() - old.at >= 60) this.captures.delete(oldKey);
    }
    this.captures.set(key, entry);
    return entry.result;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.waits.delete(finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.waits.add(finish);
      if (this.stopped) finish();
    });
  }

  readFrame = async (input: FrameInput): Promise<Frame> => {
    this.backend.frameRead();
    const deadline = performance.now() + input.waitMs;
    while (!this.stopped) {
      const frame = await this.capture(input);
      if (this.stopped) break;
      const changed = frame.image !== null && frame.hash !== input.since;
      const result = { ...frame, changed, image: changed ? frame.image : null };
      const remaining = deadline - performance.now();
      if (changed || frame.status !== "ready" || !frame.hash || remaining <= 0) return result;
      const capturedAt = performance.now();
      while (!this.stopped) {
        const left = deadline - performance.now();
        if (left <= 0) return result;
        await this.wait(Math.min(10, left));
        if (this.stopped) break;
        const state = await this.backend.changed({ ...input, windowId: frame.windowId, since: frame.hash });
        const age = performance.now() - capturedAt;
        if (state.supported ? state.changed || age >= 1000 : age >= 33) break;
      }
    }
    return unavailable("The BrowserOS plugin has stopped.");
  };

  fitDisplay = (input: Parameters<BrowserBackend["fitDisplay"]>[0]) => this.backend.fitDisplay(input);

  sendInput = async (input: Parameters<BrowserBackend["sendInput"]>[0]) => {
    try { return await this.backend.sendInput(input); }
    finally { this.captures.clear(); }
  };

  launchBrowser = async () => {
    try { return await this.backend.launchBrowser(); }
    finally { this.captures.clear(); }
  };

  async stop(): Promise<void> {
    this.stopped = true;
    for (const finish of this.waits) finish();
    this.captures.clear();
    await this.backend.stop();
  }
}
