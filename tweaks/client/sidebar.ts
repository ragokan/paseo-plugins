import { readWaiting, subscribeWaiting } from "./agents";
import { alwaysHidden, readDone, readHidden, subscribe } from "./hosts";
import { splitIdle, type BuildShortcuts, type GroupingInput, type Projection } from "./idle";

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const console: { warn(...args: unknown[]): void };

// The fields of Paseo's SidebarProjectionInput this plugin reads or rewrites.
export interface ProjectionInput {
  projects: Array<{ projectName: string; viewKey: string }>;
  workspaceEntriesByKey: Map<string, { projectViewKey?: string; projectName?: string }>;
}

type BuildProjection = ((input: ProjectionInput & GroupingInput) => Projection) & {
  original?: BuildProjection;
  loads?: number;
  // Missing on a wrapper from an older copy.
  stop?: () => void;
};
interface ProjectionModule {
  buildSidebarProjection: BuildProjection;
}
interface OrderStore {
  getState(): { pinnedWorkspaceOrder: string[] };
  setState(partial: { pinnedWorkspaceOrder: string[] }): void;
}
export interface SidebarModules {
  projection: ProjectionModule;
  orderStore: OrderStore;
  // Missing if Paseo renames it; Idle's shortcuts then follow Paseo's own numbering.
  buildShortcuts?: BuildShortcuts;
}
// An entry in Metro's module registry. Metro reads the factory when the app first requires the
// module, runs it, then drops it.
interface MetroModule {
  isInitialized?: boolean;
  publicModule?: { exports?: Record<string, unknown> };
  factory?: unknown;
}
export type MetroModules = ReadonlyMap<unknown, MetroModule>;
type ModuleListener = (exports: Record<string, unknown>) => void;
// A factory that, once its module has run, hands the exports to every copy of this plugin listening.
type Hook = ((...args: unknown[]) => unknown) & { original: (...args: unknown[]) => unknown; listeners: Set<ModuleListener> };
const isHook = (factory: unknown): factory is Hook => typeof factory === "function" && "listeners" in factory;

/**
 * Leaves the named groups, and those whose name starts with a digit, out of the sidebar with their chats,
 * pinned ones included: Paseo takes pinned chats from the groups it is given. In status grouping the
 * chats come from the workspace entries, so those go too.
 */
export function hideProjects<Input extends ProjectionInput>(input: Input, names: ReadonlySet<string>): Input {
  const isHidden = (name: string | undefined) => name !== undefined && (names.has(name) || alwaysHidden(name));
  const hidden = new Set(input.projects.filter((project) => isHidden(project.projectName)).map((project) => project.viewKey));
  if (hidden.size === 0) return input;
  const shown = (entry: { projectViewKey?: string; projectName?: string }) =>
    !(entry.projectViewKey && hidden.has(entry.projectViewKey)) && !isHidden(entry.projectName);
  const entries = [...input.workspaceEntriesByKey].filter(([, entry]) => shown(entry));
  return {
    ...input,
    projects: input.projects.filter((project) => !hidden.has(project.viewKey)),
    workspaceEntriesByKey: new Map(entries),
  };
}

// shortcut: the plugin SDK has no sidebar API, so this plugin finds the app's own modules among
// those Metro has loaded. Breaks if Metro stops keeping modules in a Map; switch to SDK calls once
// they exist.
/** Metro's module registry, the live Map, so it can be searched again as the app loads more. */
export function metroModules(): MetroModules {
  const metroRequire = (globalThis as { __r?: (id: unknown) => unknown }).__r;
  if (typeof metroRequire !== "function") throw new Error("Metro runtime not found");
  // Metro's require starts with modules.get(id), so asking for an id no module has hands over the
  // registry Map. The probe answers as an already loaded module, so Metro runs no module code and
  // takes no error path, which would be fatal in a release build on iOS and Android.
  const probe = Symbol("tweaks");
  const get = Map.prototype.get;
  let modules: Map<unknown, MetroModule> | undefined;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    if (key !== probe) return get.call(this, key);
    modules = this as Map<unknown, MetroModule>;
    return { isInitialized: true, publicModule: { exports: undefined } };
  };
  try {
    metroRequire(probe);
  } finally {
    Map.prototype.get = get;
  }
  if (!modules) throw new Error("Metro module registry not found");
  return modules;
}

/** The exports of the modules the app has run. Only those: requiring another one would run its code early. */
export function* loadedExports(modules: MetroModules): Generator<Record<string, unknown>> {
  for (const module of modules.values()) {
    const exports = module?.isInitialized ? module.publicModule?.exports : undefined;
    if (exports) yield exports;
  }
}

/**
 * Calls listener with the exports of each module the app runs from now on, as it runs, before the
 * code that required it uses them. It wraps the factories of the modules not run yet; the app loads
 * this plugin once per host that has it, so loads share the wrappers, and the last one to stop puts
 * the factories back. Returns a function that stops listening.
 */
export function onModuleRun(modules: MetroModules, listener: ModuleListener): () => void {
  const existing = [...modules.values()].find((module) => isHook(module?.factory))?.factory as Hook | undefined;
  const listeners = existing?.listeners ?? new Set<ModuleListener>();
  // A callback per module, not a for loop: on iOS and Android, Hermes gives a loop's const one slot
  // for every closure made in it, so each hook would run the last module's factory.
  modules.forEach((module) => {
    const original = module?.factory;
    if (!module || module.isInitialized || typeof original !== "function" || isHook(original)) return;
    const hook = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      const exports = module.publicModule?.exports;
      for (const listen of [...listeners]) {
        // A listener that fails leaves the module as it ran: throwing here would fail the app's require.
        try {
          if (exports) listen(exports);
        } catch (error) {
          console.warn("[tweaks]", error);
        }
      }
      return result;
    };
    module.factory = Object.assign(hook, { original, listeners });
  });
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    for (const module of modules.values()) {
      const factory = module?.factory;
      if (isHook(factory) && factory.listeners === listeners) module.factory = factory.original;
    }
  };
}

/**
 * buildSidebarProjection, which lays out the sidebar's groups and its keyboard shortcuts, the sidebar
 * order store, nudged so the sidebar lays itself out again, and buildSidebarShortcutSections, which
 * numbers the shortcuts again once Waiting and Idle are split off. Breaks if Paseo renames them.
 */
export function findSidebarModules(modules: MetroModules = metroModules()): SidebarModules {
  let projection: ProjectionModule | undefined;
  let orderStore: OrderStore | undefined;
  let buildShortcuts: BuildShortcuts | undefined;
  for (const exports of loadedExports(modules)) {
    if (typeof exports.buildSidebarProjection === "function") projection = exports as unknown as ProjectionModule;
    const store = exports.useSidebarOrderStore as Partial<OrderStore> | undefined;
    if (typeof store?.setState === "function" && Array.isArray(store.getState?.().pinnedWorkspaceOrder)) {
      orderStore = store as OrderStore;
    }
    if (typeof exports.buildSidebarShortcutSections === "function") {
      buildShortcuts = exports.buildSidebarShortcutSections as BuildShortcuts;
    }
  }
  if (!projection) throw new Error("Paseo sidebar layout not found");
  if (!orderStore) throw new Error("Paseo sidebar order not found");
  return { projection, orderStore, buildShortcuts };
}

// The sidebar recomputes its layout only when its inputs change; a fresh copy of the saved
// pinned order is one of them and changes nothing else.
function relayout(orderStore: OrderStore) {
  orderStore.setState({ pinnedWorkspaceOrder: [...orderStore.getState().pinnedWorkspaceOrder] });
}

// The app loads this plugin once per host that has it installed, so loads share one wrapper and
// the last one to unload restores the original.
export function patch({ projection, orderStore, buildShortcuts }: SidebarModules): () => void {
  let wrapper = projection.buildSidebarProjection;
  if (!wrapper.original) {
    const original = wrapper;
    // Lays the sidebar out again when the next workspace in Idle turns Done.
    let timer: unknown;
    const layout = (input: ProjectionInput & GroupingInput) => {
      const now = Date.now();
      const result = original(hideProjects(input, readHidden()));
      const { projection: split, turnsDoneAt } = splitIdle(result, input, now, readDone(), readWaiting(), buildShortcuts);
      clearTimeout(timer);
      // A timer can fire a little early; the second's margin keeps it from finding the row still in Idle.
      timer = turnsDoneAt === null ? undefined : setTimeout(() => relayout(orderStore), turnsDoneAt - now + 1000);
      return split;
    };
    wrapper = Object.assign(layout, { original, loads: 0, stop: () => clearTimeout(timer) });
    projection.buildSidebarProjection = wrapper;
  }
  wrapper.loads! += 1;
  const unsubscribe = subscribe(() => relayout(orderStore));
  const unsubscribeWaiting = subscribeWaiting(() => relayout(orderStore));
  relayout(orderStore);
  let unloaded = false;
  return () => {
    if (unloaded) return;
    unloaded = true;
    unsubscribe();
    unsubscribeWaiting();
    wrapper.loads! -= 1;
    if (wrapper.loads === 0) {
      wrapper.stop?.();
      projection.buildSidebarProjection = wrapper.original!;
    }
    relayout(orderStore);
  };
}
