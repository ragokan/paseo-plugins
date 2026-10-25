import { useEffect, useState, useSyncExternalStore } from "react";

interface Report { row: symbol; host: string; open: boolean }
interface Store { report: Report | null; listeners: Set<() => void> }
const KEY = Symbol.for("ragokan/paseo-plugins/browseros-neo/viewing");

function store(): Store {
  const shared = globalThis as unknown as Record<symbol, Store | undefined>;
  return (shared[KEY] ??= { report: null, listeners: new Set() });
}

function publish(report: Report | null) {
  store().report = report;
  for (const listener of store().listeners) listener();
}

export function useReportScreen(host: string, open: boolean) {
  const [row] = useState(() => Symbol("browseros-row"));
  useEffect(() => { publish({ row, host, open }); }, [row, host, open]);
  useEffect(() => () => {
    if (store().report?.row === row) publish(null);
  }, [row]);
}

function subscribe(listener: () => void) {
  store().listeners.add(listener);
  return () => { store().listeners.delete(listener); };
}

export function useCurrentScreen(host: string) {
  return useSyncExternalStore(subscribe, () => {
    const report = store().report;
    return report === null || (report.host === host && report.open);
  });
}
