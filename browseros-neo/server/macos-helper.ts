import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, arch } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { macHelperSource } from "./macos-source.ts";

const execute = promisify(execFile);
export const preparing = "Preparing the macOS helper; the first start compiles it…";
export const toolchainNeeded = "Install the Xcode Command Line Tools: xcode-select --install";
export const macCacheRoot = join(homedir(), "Library", "Caches", "paseo-browseros-neo");
export function helperPath(source = macHelperSource, root = macCacheRoot): string {
  return join(root, createHash("sha256").update(source).digest("hex"), "helper");
}

type Preparation = { binary: string; reason?: never } | { binary?: never; reason: string };
type CacheOptions = { source?: string; root?: string; execute?: typeof execute };

/** Pollable first-use compilation: no frame RPC waits for swiftc. Failures are sticky. */
export class MacHelperCache {
  private state: Preparation = { reason: preparing };
  private task?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly source: string;
  readonly binary: string;
  private readonly run: typeof execute;

  constructor(options: CacheOptions = {}) {
    this.source = options.source ?? macHelperSource;
    this.binary = helperPath(this.source, options.root);
    this.run = options.execute ?? execute;
  }

  prepare(): Preparation {
    if (!this.task && !this.abort.signal.aborted) this.task = this.compile();
    return this.state;
  }

  private async compile(): Promise<void> {
    let temporary: string | undefined;
    try {
      const { stdout } = await this.run("/usr/bin/sw_vers", ["-productVersion"]);
      const version = stdout.trim();
      if (Number(version.split(".")[0]) < 14) throw new Error(`BrowserOS remote display requires macOS 14 or later; this Mac runs macOS ${version}.`);
      try { await access(this.binary, constants.X_OK); this.state = { binary: this.binary }; return; } catch { /* Compile once per source. */ }
      try { await this.run("/usr/bin/xcrun", ["--find", "swiftc"], { signal: this.abort.signal }); }
      catch { throw new Error(toolchainNeeded); }
      const directory = join(this.binary, "..");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      temporary = join(directory, `helper-${randomUUID()}`);
      const sourcePath = `${temporary}.swift`;
      try {
        await writeFile(sourcePath, this.source, { mode: 0o600 });
        await this.run("/usr/bin/xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", `${arch() === "x64" ? "x86_64" : arch()}-apple-macosx14.0`, sourcePath, "-o", temporary], {
          timeout: 180_000, maxBuffer: 1024 * 1024, signal: this.abort.signal,
        });
        if (!this.abort.signal.aborted) {
          await rename(temporary, this.binary);
          this.state = { binary: this.binary };
        }
      } finally { await rm(sourcePath, { force: true }); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { reason: message === toolchainNeeded || message.startsWith("BrowserOS remote display requires")
        ? message : `The macOS helper could not be compiled: ${message}` };
    } finally { if (temporary) await rm(temporary, { force: true }); }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.state = { reason: "The BrowserOS plugin has stopped." };
    await this.task;
    this.state = { reason: "The BrowserOS plugin has stopped." };
  }
}
