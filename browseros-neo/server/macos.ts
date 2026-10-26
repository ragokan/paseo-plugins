import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Frame } from "../shared/contracts.ts";
import type { fitDisplay, launchBrowser, sendInput } from "../shared/contracts.ts";
import { unavailable, type BrowserBackend, type CaptureInput, type ChangeState } from "./backend.ts";
import { DisplayFitter } from "./display.ts";
import { DesktopHelper, type HelperTransport } from "./helper.ts";
import { MacHelperCache, macHelperRoot } from "./macos-helper.ts";

type InputResult = RpcOutput<typeof sendInput>;

export class MacOSBackend implements BrowserBackend {
  private helper?: HelperTransport;
  private stopped = false;
  private readonly display: DisplayFitter;
  private readonly cache: MacHelperCache;
  private readonly onChange: () => void;

  constructor(cache = new MacHelperCache(), onChange = () => {}, options: {
    helper?: HelperTransport; debounceMs?: number; idleMs?: number;
  } = {}) {
    this.cache = cache;
    this.onChange = onChange;
    this.helper = options.helper;
    this.display = new DisplayFitter({
      geometry: {
        apply: (target) => this.request("fit", target),
        restore: () => this.helper ? this.helper.request("restore", {}) : Promise.resolve({ ok: true, width: 0, height: 0, error: null }),
      }, onChange, debounceMs: options.debounceMs, idleMs: options.idleMs,
    });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("The BrowserOS plugin has stopped."));
    if (!this.helper) {
      const state = this.cache.prepare();
      if (!state.binary) return Promise.reject(new Error(state.reason));
      // Keep the process (and original AX geometry) alive. Swift expires only its SCStream.
      this.helper = new DesktopHelper(0, { executable: state.binary, args: [], env: {
        ...process.env, PASEO_BROWSEROS_PERMISSION_DIR: macHelperRoot,
        PASEO_BROWSEROS_PERMISSION_OWNER: process.execPath,
      } });
    }
    return this.helper.request<T>(method, params);
  }

  async capture(input: CaptureInput): Promise<Frame> {
    try { return await this.request("frame", input); } catch (error) { return unavailable(error); }
  }
  async changed(input: CaptureInput): Promise<ChangeState> {
    try { return await this.request("changed", input); } catch { return { supported: false, changed: true }; }
  }
  frameRead(): void { this.display.frameRead(); }
  fitDisplay = (input: RpcInput<typeof fitDisplay>) => this.display.fit(input);
  async activate(windowId: string): Promise<InputResult> {
    try { return await this.request("activate", { windowId }); } catch (error) { return this.failure(error); }
  }
  async sendInput(input: RpcInput<typeof sendInput>): Promise<InputResult> {
    // Swift's JSON parser rejects lone UTF-16 surrogates that JSON.stringify accepts.
    const events = input.events.map((event) => event.type === "text"
      ? { ...event, text: Buffer.from(event.text, "utf8").toString("utf8") }
      : event.type === "key" ? { ...event, key: Buffer.from(event.key, "utf8").toString("utf8") } : event);
    try { return await this.request("input", { ...input, events }); } catch (error) { return this.failure(error); }
    finally { this.onChange(); }
  }
  async launchBrowser(): Promise<RpcOutput<typeof launchBrowser>> {
    try { return await this.request("launch", {}); } catch (error) { return this.failure(error); }
    finally { this.onChange(); }
  }
  private failure(error: unknown): InputResult { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const restored = await this.display.stop();
    if (!restored.ok) console.error(`BrowserOS window restore failed: ${restored.error}`);
    await this.helper?.stop();
    await this.cache.stop();
  }
}
