import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_AGE_MS, type Turns } from "./turns.ts";

export interface Saved {
  /** The daemon worker that last ran this plugin; a different one means the daemon restarted. */
  daemonPid: number | null;
  turns: Turns;
}

/** Per daemon home, and the same for this plugin's standalone and bundled copies. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PASEO_HOME || path.join(homedir(), ".paseo"), "plugin-data", "continue-after-error");
}

export function load(directory: string): Saved {
  let text: string;
  try {
    text = readFileSync(path.join(directory, "turns.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { daemonPid: null, turns: {} };
  }
  try {
    const saved = JSON.parse(text) as Partial<Saved>;
    return {
      daemonPid: typeof saved.daemonPid === "number" ? saved.daemonPid : null,
      turns: saved.turns && typeof saved.turns === "object" ? saved.turns : {},
    };
  } catch (error) {
    console.error("[continue-after-error] turns.json is unreadable; starting over", error);
    return { daemonPid: null, turns: {} };
  }
}

export function save(directory: string, saved: Saved): void {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "turns.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(saved));
  renameSync(temporary, file);
}

/**
 * True for the first copy of this plugin to claim a turn's resume in this daemon run, so the
 * standalone plugin and the all plugin installed side by side send it once.
 */
export function claim(directory: string, agentId: string, startedAt: number, daemonPid: number): boolean {
  const claims = path.join(directory, "claims");
  mkdirSync(claims, { recursive: true });
  try {
    closeSync(openSync(path.join(claims, `${agentId}-${startedAt}-${daemonPid}`), "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function pruneClaims(directory: string, now: number): void {
  const claims = path.join(directory, "claims");
  let names: string[];
  try {
    names = readdirSync(claims);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(claims, name);
    if (now - statSync(file).mtimeMs > 2 * MAX_AGE_MS) rmSync(file, { force: true });
  }
}
