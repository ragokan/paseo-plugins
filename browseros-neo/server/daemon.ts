import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Frame } from "../shared/contracts.ts";
import { fitDisplay, launchBrowser, readFrame, sendInput } from "../shared/contracts.ts";
import { DesktopHelper, desktopEnvironment, type HelperTransport } from "./helper.ts";
import { DisplayFitter, type DisplayGeometry } from "./display.ts";

type FrameInput = RpcInput<typeof readFrame>;
type CaptureInput = Pick<FrameInput, "windowId" | "maxWidth" | "maxHeight" | "quality" | "lossless">;
type InputResult = RpcOutput<typeof sendInput>;

function unavailable(error: unknown): Frame {
  return {
    status: "unsupported", reason: error instanceof Error ? error.message : String(error),
    windows: [], windowId: null, windowWidth: 0, windowHeight: 0, hash: null,
    changed: false, image: null, mimeType: "image/jpeg", imageWidth: 0, imageHeight: 0,
  };
}

export class BrowserDaemon {
  private stopped = false;
  private captures = new Map<string, { at: number; result: Promise<Frame>; pending: boolean }>();
  private defaultWindow: string | null = null;
  private waits = new Set<() => void>();
  private readonly helper: HelperTransport;
  private readonly display: DisplayFitter;

  constructor(helper: HelperTransport = new DesktopHelper()) {
    this.helper = helper;
    this.display = new DisplayFitter({
      readDesktop: () => this.helper.request<DisplayGeometry>("display", {}),
      onChange: () => this.captures.clear(),
    });
  }

  private capture(input: CaptureInput): Promise<Frame> {
    const key = JSON.stringify([input.windowId ?? this.defaultWindow, input.maxWidth, input.maxHeight, input.quality, input.lossless ?? false]);
    const existing = this.captures.get(key);
    if (existing && (existing.pending || performance.now() - existing.at < 60)) return existing.result;
    const entry = { at: performance.now(), pending: true, result: Promise.resolve(null as unknown as Frame) };
    entry.result = (async () => {
      const previous = await existing?.result;
      let frame = await this.helper.request<Frame>("frame", { ...input, since: previous?.hash ?? null });
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
    this.display.frameRead();
    const deadline = performance.now() + input.waitMs;
    while (!this.stopped) {
      const frame = await this.capture(input);
      if (this.stopped) break;
      const changed = frame.image !== null && frame.hash !== input.since;
      const result = { ...frame, changed, image: changed ? frame.image : null };
      const remaining = deadline - performance.now();
      if (changed || frame.status !== "ready" || !frame.hash || remaining <= 0) return result;
      await this.wait(Math.min(90, remaining));
    }
    return unavailable("The BrowserOS plugin has stopped.");
  };

  fitDisplay = (input: RpcInput<typeof fitDisplay>): Promise<RpcOutput<typeof fitDisplay>> => this.display.fit(input);

  sendInput = async (input: RpcInput<typeof sendInput>): Promise<InputResult> => {
    try {
      const characters = input.events.reduce((count, event) => count + (event.type === "text" ? event.text.length : 0), 0);
      const result = await this.helper.request<InputResult>("input", input, Math.max(15_000, characters * 60 + 15_000));
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.captures.clear();
    }
  };

  launchBrowser = async (): Promise<RpcOutput<typeof launchBrowser>> => {
    if (this.stopped) return { ok: false, error: "The BrowserOS plugin has stopped." };
    try {
      const frame = await this.helper.request<Frame>("frame", { windowId: null, maxWidth: 64, maxHeight: 64, quality: 20 });
      if (frame.windowId) {
        const result = await this.helper.request<InputResult>("activate", { windowId: frame.windowId });
        this.captures.clear();
        return result;
      }
      if (frame.status === "unsupported") return { ok: false, error: frame.reason };
      const candidates = [
        ...["browserclaw", "browseros"].flatMap((name) =>
          (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name))),
        "/usr/bin/browserclaw", "/usr/lib/browserclaw/browserclaw", "/opt/browseros/browseros",
      ];
      let executable: string | undefined;
      for (const candidate of candidates) {
        try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Try the next launcher. */ }
      }
      if (!executable) return { ok: false, error: "BrowserOS was not found. Looked for browserclaw and browseros on PATH, /usr/bin/browserclaw, /usr/lib/browserclaw/browserclaw and /opt/browseros/browseros." };
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, [], { detached: true, stdio: "ignore", env: desktopEnvironment() });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      this.captures.clear();
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  async stop(): Promise<void> {
    this.stopped = true;
    for (const finish of this.waits) finish();
    this.captures.clear();
    const restored = await this.display.stop();
    if (!restored.ok) console.error(`BrowserOS display restore failed: ${restored.error}`);
    await this.helper.stop();
  }
}
