import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Frame } from "../shared/contracts.ts";
import { fitDisplay, launchBrowser, readFrame, sendInput } from "../shared/contracts.ts";
import { LinuxBackend } from "./linux.ts";
import { MacOSBackend } from "./macos.ts";
export { MacOSBackend } from "./macos.ts";

export type CaptureInput = Omit<RpcInput<typeof readFrame>, "waitMs"> & {
  /** Populate Node's image cache even if this caller already has the frame. */
  includeImage?: boolean;
};
export type ChangeState = { supported: boolean; changed: boolean };
export interface BrowserBackend {
  capture(input: CaptureInput): Promise<Frame>;
  changed(input: CaptureInput): Promise<ChangeState>;
  sendInput(input: RpcInput<typeof sendInput>): Promise<RpcOutput<typeof sendInput>>;
  activate(windowId: string): Promise<RpcOutput<typeof sendInput>>;
  launchBrowser(): Promise<RpcOutput<typeof launchBrowser>>;
  fitDisplay(input: RpcInput<typeof fitDisplay>): Promise<RpcOutput<typeof fitDisplay>>;
  frameRead(): void;
  /** Restores touched display/window geometry before releasing native resources. */
  stop(): Promise<void>;
}

export function unavailable(error: unknown): Frame {
  return {
    status: "unsupported", reason: error instanceof Error ? error.message : String(error),
    windows: [], windowId: null, windowWidth: 0, windowHeight: 0, hash: null,
    changed: false, image: null, mimeType: "image/jpeg", imageWidth: 0, imageHeight: 0,
  };
}

export class UnsupportedBackend implements BrowserBackend {
  readonly reason: string;
  constructor(reason: string) { this.reason = reason; }
  async capture(): Promise<Frame> { return unavailable(this.reason); }
  async changed(): Promise<ChangeState> { return { supported: false, changed: true }; }
  async sendInput() { return { ok: false, error: this.reason }; }
  async activate() { return { ok: false, error: this.reason }; }
  async launchBrowser() { return { ok: false, error: this.reason }; }
  async fitDisplay() { return { ok: false, width: 0, height: 0, error: this.reason }; }
  frameRead(): void {}
  async stop(): Promise<void> {}
}

export function createBackend(platform: NodeJS.Platform, onChange = () => {}): BrowserBackend {
  if (platform === "linux") return new LinuxBackend(undefined, onChange);
  if (platform === "darwin") return new MacOSBackend(undefined, onChange);
  return new UnsupportedBackend(`BrowserOS remote display does not support ${platform}.`);
}
