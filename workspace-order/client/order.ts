// This plugin typechecks without the DOM library. Declare only what this module uses. localStorage
// exists on desktop and web only.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined;

// Paseo keeps its own sidebar order in this client's storage too, so the order lives beside it.
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
const listeners = new Set<() => void>();

// Reads storage on every call, so a copy of the plugin loaded for another host sees the same
// order; the parsed list is reused until the stored text changes.
export function readOrder(): string[] {
  // iOS and Android: no order, and the page that saves one is not there.
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cache.raw) cache = { raw, names: parse(raw) };
  return cache.names;
}

export function saveOrder(names: string[]) {
  localStorage!.setItem(STORAGE_KEY, JSON.stringify(names));
  for (const listener of listeners) listener();
}

export function subscribeOrder(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
