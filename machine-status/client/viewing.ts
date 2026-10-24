import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Which host's Machine screen is the current route, as the sidebar reports it.
 * Paseo draws one Machine row, from the copy of this plugin whose host the
 * current route is on, and tells the row whether its own screen is that route.
 * Paseo keeps a screen mounted under the ones opened on top of it, so the
 * screen polls only while the row says it is current. The app loads one copy per
 * host, each its own module, so the report lives on globalThis, where every
 * copy's screen reads it.
 */
interface Report {
  host: string;
  open: boolean;
  row: symbol;
}

interface Store {
  report: Report | null;
  listeners: Set<() => void>;
}

const KEY = Symbol.for("ragokan/paseo-plugins/machine-status/viewing");

function store(): Store {
  const global = globalThis as unknown as Record<symbol, Store | undefined>;
  return (global[KEY] ??= { report: null, listeners: new Set() });
}

function publish(report: Report | null) {
  const current = store();
  current.report = report;
  for (const listener of current.listeners) listener();
}

export function subscribe(listener: () => void) {
  const current = store();
  current.listeners.add(listener);
  return () => current.listeners.delete(listener);
}

/** A row's report: whether its host's Machine screen is the current route. */
export function report(row: symbol, host: string, open: boolean) {
  publish({ host, open, row });
}

/** A row that goes leaves no report, unless another row has already replaced it. */
export function withdraw(row: symbol) {
  if (store().report?.row === row) publish(null);
}

/**
 * Whether the host's Machine screen may read: false once the sidebar reports
 * another screen as current. Without a sidebar row to ask, such as one the user
 * hid, the screen counts as current, as it did before.
 */
export function isCurrent(host: string): boolean {
  const current = store().report;
  return current === null || (current.host === host && current.open);
}

/** For the sidebar row. */
export function useReportScreen(host: string, open: boolean) {
  const [row] = useState(() => Symbol("machine-row"));
  useEffect(() => report(row, host, open), [row, host, open]);
  useEffect(() => () => withdraw(row), [row]);
}

/** For the screen. */
export function useCurrentScreen(host: string): boolean {
  return useSyncExternalStore(subscribe, () => isCurrent(host));
}
