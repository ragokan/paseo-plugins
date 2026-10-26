import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, arch } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { macHelperSource } from "./macos-source.ts";

const execute = promisify(execFile);
export const preparing = "Preparing the macOS helper; the first start compiles it…";
export const toolchainNeeded = "Install the Xcode Command Line Tools: xcode-select --install";
export const macHelperRoot = join(homedir(), "Library", "Application Support", "Paseo", "browseros-neo");
export function helperPath(root = macHelperRoot): string {
  return join(root, "helper");
}

type Preparation = { binary: string; reason?: never } | { binary?: never; reason: string };
type CacheOptions = { source?: string; root?: string; execute?: typeof execute };

/** Pollable first-use compilation: no frame RPC waits for swiftc. Failures are sticky. */
export class MacHelperCache {
  private state: Preparation = { reason: preparing };
  private task?: Promise<void>;
  private readonly abort = new AbortController();
  private readonly source: string;
  private readonly sourceHash: string;
  readonly binary: string;
  private readonly run: typeof execute;

  constructor(options: CacheOptions = {}) {
    this.source = options.source ?? macHelperSource;
    this.sourceHash = createHash("sha256").update(this.source).digest("hex");
    this.binary = helperPath(options.root);
    this.run = options.execute ?? execute;
  }

  prepare(): Preparation {
    if (!this.task && !this.abort.signal.aborted) this.task = this.compile();
    return this.state;
  }

  private async compile(): Promise<void> {
    let temporaryDirectory: string | undefined;
    try {
      const { stdout } = await this.run("/usr/bin/sw_vers", ["-productVersion"]);
      const version = stdout.trim();
      if (Number(version.split(".")[0]) < 14) throw new Error(`BrowserOS remote display requires macOS 14 or later; this Mac runs macOS ${version}.`);
      try {
        await access(this.binary, constants.X_OK);
        const { stdout } = await this.run(this.binary, ["--source-hash"], { timeout: 5000, maxBuffer: 1024, signal: this.abort.signal });
        if (stdout.trim() === this.sourceHash) { this.state = { binary: this.binary }; return; }
      } catch { /* Missing, outdated or invalid helper: compile the current source. */ }
      try { await this.run("/usr/bin/xcrun", ["--find", "swiftc"], { signal: this.abort.signal }); }
      catch { throw new Error(toolchainNeeded); }
      const directory = join(this.binary, "..");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // swiftc uses the output basename as the code identifier. Keep it stable
      // inside a private directory on the same filesystem as the final helper.
      temporaryDirectory = await mkdtemp(join(directory, ".build-"));
      const temporary = join(temporaryDirectory, "helper");
      const sourcePath = join(temporaryDirectory, "helper.swift");
      const versionCheck = 'import Foundation\nif CommandLine.arguments.contains("--source-hash") { print("' + this.sourceHash + '"); exit(0) }\n';
      await writeFile(sourcePath, versionCheck + this.source, { mode: 0o600 });
      await this.run("/usr/bin/xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", `${arch() === "x64" ? "x86_64" : arch()}-apple-macosx14.0`, sourcePath, "-o", temporary], {
        timeout: 180_000, maxBuffer: 1024 * 1024, signal: this.abort.signal,
      });
      if (!this.abort.signal.aborted) {
        await rename(temporary, this.binary);
        this.state = { binary: this.binary };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { reason: message === toolchainNeeded || message.startsWith("BrowserOS remote display requires")
        ? message : `The macOS helper could not be compiled: ${message}` };
    } finally {
      // A linker exiting after an abort may briefly keep writing here. Cleanup
      // is best-effort and must never make plugin shutdown fail.
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.state = { reason: "The BrowserOS plugin has stopped." };
    await this.task;
    this.state = { reason: "The BrowserOS plugin has stopped." };
  }
}
