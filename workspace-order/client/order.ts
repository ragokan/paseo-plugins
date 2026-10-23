import { readSyncedOrder, saveSyncedOrder, subscribe } from "./hosts";

// This plugin typechecks without the DOM library. Declare only what this module uses. localStorage
// exists on desktop and web only.
declare const localStorage: { getItem(key: string): string | null } | undefined;

// Where this app kept the order before the hosts did; it shows until an order is saved there.
// Names, not Paseo's keys: a group's key changes with the hosts the sidebar shows, its name does not.
const STORAGE_KEY = "workspace-order:names";

function parse(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

let cache: { raw: string | null; names: string[] } = { raw: null, names: [] };

// The parsed list is reused until the stored text changes.
function readLocalOrder(): string[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cache.raw) cache = { raw, names: parse(raw) };
  return cache.names;
}

/** The order saved on the hosts, else the one this app kept before. */
export function readOrder(): readonly string[] {
  return readSyncedOrder() ?? readLocalOrder();
}

/** Saves on every host the app reaches, so every app connected to them follows it. */
export function saveOrder(names: string[]) {
  return saveSyncedOrder(names);
}

export const subscribeOrder = subscribe;
