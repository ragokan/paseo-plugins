import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Frame } from "../shared/contracts.ts";
import type { BrowserBackend, CaptureInput, ChangeState } from "./backend.ts";
import { fitDisplay, launchBrowser, sendInput } from "../shared/contracts.ts";
import { DesktopHelper, desktopEnvironment, type HelperTransport } from "./helper.ts";
import { DisplayFitter, type DisplayGeometry } from "./display.ts";

type InputResult = RpcOutput<typeof sendInput>;

export class LinuxBackend implements BrowserBackend {
  private stopped = false;
  private readonly helper: HelperTransport;
  private readonly display: DisplayFitter;
  private readonly onChange: () => void;

  constructor(helper: HelperTransport = new DesktopHelper(), onChange = () => {}) {
    this.helper = helper;
    this.onChange = onChange;
    this.display = new DisplayFitter({ readDesktop: () => helper.request<DisplayGeometry>("display", {}), onChange });
  }

  capture(input: CaptureInput): Promise<Frame> { return this.helper.request("frame", input); }
  async changed(input: CaptureInput): Promise<ChangeState> {
    try {
      const result = await this.helper.request<ChangeState>("changed", input);
      return { supported: result.supported === true, changed: result.changed === true };
    } catch { return { supported: false, changed: true }; }
  }
  frameRead(): void { this.display.frameRead(); }
  fitDisplay = (input: RpcInput<typeof fitDisplay>): Promise<RpcOutput<typeof fitDisplay>> => this.display.fit(input);
  activate(windowId: string): Promise<InputResult> { return this.helper.request("activate", { windowId }); }
  sendInput = async (input: RpcInput<typeof sendInput>): Promise<InputResult> => {
    try {
      const characters = input.events.reduce((count, event) => count + (event.type === "text" ? event.text.length : 0), 0);
      const result = await this.helper.request<InputResult>("input", input, Math.max(15_000, characters * 60 + 15_000));
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.onChange();
    }
  };

  launchBrowser = async (): Promise<RpcOutput<typeof launchBrowser>> => {
    if (this.stopped) return { ok: false, error: "The BrowserOS plugin has stopped." };
    try {
      const frame = await this.helper.request<Frame>("frame", { windowId: null, maxWidth: 64, maxHeight: 64, quality: 20 });
      if (frame.windowId) {
        const result = await this.helper.request<InputResult>("activate", { windowId: frame.windowId });
        this.onChange();
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
      this.onChange();
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  async stop(): Promise<void> {
    this.stopped = true;
    const restored = await this.display.stop();
    if (!restored.ok) console.error(`BrowserOS display restore failed: ${restored.error}`);
    await this.helper.stop();
  }
}
