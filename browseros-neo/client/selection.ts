import type { Frame } from "../shared/contracts.ts";

const KEY = Symbol.for("ragokan/paseo-plugins/browseros-neo/selection");
type Picks = Map<string, string>;

function picks(): Picks {
  const shared = globalThis as unknown as Record<symbol, Picks | undefined>;
  return (shared[KEY] ??= new Map());
}

export function rememberedWindow(host: string): string | null {
  return picks().get(host) ?? null;
}

export function rememberWindow(host: string, windowId: string | null) {
  if (windowId === null) picks().delete(host);
  else picks().set(host, windowId);
}

export function pinWindow(selected: string | null, frame: Pick<Frame, "status" | "windows" | "windowId">): string | null {
  if (frame.status !== "ready") return selected;
  if (selected && frame.windows.some((item) => item.id === selected)) return selected;
  return frame.windowId;
}
