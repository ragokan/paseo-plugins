import type { InputEvent } from "../shared/contracts.ts";

const KEY = Symbol.for("ragokan/paseo-plugins/browseros-neo/connection");
type HostId = string;
type Connections = Set<HostId>;

function connections(): Connections {
  const shared = globalThis as unknown as Record<symbol, Connections | undefined>;
  return (shared[KEY] ??= new Set());
}

export function rememberedConnection(host: string): boolean { return connections().has(host); }
export function rememberConnection(host: string, connected: boolean) {
  if (connected) connections().add(host);
  else connections().delete(host);
}

export interface ConnectionState { connected: boolean; visible: boolean; foreground: boolean }
export function connectionActive(state: ConnectionState): boolean {
  return state.connected && state.visible && state.foreground;
}

/** Only releases of previously sent button presses may cross the closed gate. */
export function isReleaseInput(events: readonly InputEvent[]): boolean {
  return events.length > 0 && events.every((event) => event.type === "up");
}
