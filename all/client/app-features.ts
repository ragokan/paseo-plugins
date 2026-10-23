import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { DEFAULT_APP_FEATURES, type AppFeatureId, type AppFeatures } from "../shared/features";
import { createSwitches, type Contribution } from "./switches";

// This plugin typechecks without the DOM library. localStorage exists on desktop and web only.
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined;

type Contributions = Record<AppFeatureId, Contribution>;
interface Copy {
  client: PluginClientContext;
  contributions: Contributions;
}
interface Shared {
  copies: Copy[];
  owner: { copy: Copy; switches: ReturnType<typeof createSwitches<AppFeatureId>> } | null;
  features: AppFeatures;
  queue: Promise<void>;
  listeners: Set<() => void>;
}

const STORAGE_KEY = "ragokan/paseo-plugins/all/app-features";
export const canSaveAppFeatures = typeof localStorage !== "undefined";

function load(): AppFeatures {
  try {
    const saved: unknown = canSaveAppFeatures ? JSON.parse(localStorage!.getItem(STORAGE_KEY) ?? "{}") : {};
    const features = { ...DEFAULT_APP_FEATURES };
    for (const id of Object.keys(features) as AppFeatureId[]) {
      const value = (saved as Partial<AppFeatures> | null)?.[id];
      if (typeof value === "boolean") features[id] = value;
    }
    return features;
  } catch {
    return { ...DEFAULT_APP_FEATURES };
  }
}

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. They
// meet here, so one copy runs the app plugins and another takes over when it stops. Bump the
// version when this shape changes, so copies of different versions do not share it.
const SHARED = Symbol.for("ragokan/paseo-plugins/all/app-features@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { copies: [], owner: null, features: load(), queue: Promise.resolve(), listeners: new Set() });
}

function run(work: (state: Shared) => Promise<void> | void) {
  const state = shared();
  state.queue = state.queue.then(() => work(state)).catch((error: unknown) => console.warn("[all] app plugins:", error));
  return state.queue;
}

function takeOver(state: Shared) {
  const copy = state.copies[0];
  if (!copy) return;
  const switches = createSwitches(copy.client, copy.contributions);
  state.owner = { copy, switches };
  return switches.apply(state.features);
}

/** Runs the app plugins from this copy unless another copy already does. Returns this copy's exit. */
export function joinAppFeatures(client: PluginClientContext, contributions: Contributions) {
  const copy: Copy = { client, contributions };
  void run((state) => {
    state.copies.push(copy);
    if (!state.owner) return takeOver(state);
  });
  return () =>
    run(async (state) => {
      state.copies = state.copies.filter((other) => other !== copy);
      if (state.owner?.copy !== copy) return;
      const { switches } = state.owner;
      state.owner = null;
      await switches.dispose();
      await takeOver(state);
    });
}

export function setAppFeature(id: AppFeatureId, on: boolean) {
  return run((state) => {
    state.features = { ...state.features, [id]: on };
    if (canSaveAppFeatures) localStorage!.setItem(STORAGE_KEY, JSON.stringify(state.features));
    for (const listener of state.listeners) listener();
    return state.owner?.switches.apply(state.features);
  });
}

export function useAppFeatures(): AppFeatures {
  return useSyncExternalStore(
    (listener) => {
      const { listeners } = shared();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shared().features,
  );
}
