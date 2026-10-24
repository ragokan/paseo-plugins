import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DoneSince } from "./labels.ts";

/** Per daemon home, and the same for this plugin's standalone and bundled copies. */
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PASEO_HOME || path.join(homedir(), ".paseo"), "plugin-data", "status-labels");
}

export function loadDoneSince(directory: string): DoneSince {
  let text: string;
  try {
    text = readFileSync(path.join(directory, "done-since.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
  try {
    const saved: unknown = JSON.parse(text);
    return saved && typeof saved === "object" ? (saved as DoneSince) : {};
  } catch (error) {
    console.error("[status-labels] done-since.json is unreadable; starting over", error);
    return {};
  }
}

export function saveDoneSince(directory: string, since: DoneSince): void {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "done-since.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(since));
  renameSync(temporary, file);
}
