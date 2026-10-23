import { alwaysHidden, readHidden, subscribeHidden } from "./hidden";
import { readOrder, subscribeOrder } from "./order";

// The fields of Paseo's SidebarProjectionInput this plugin reads or rewrites.
export interface ProjectionInput {
  projects: Array<{ projectName: string; viewKey: string }>;
  workspaceEntriesByKey: Map<string, { projectViewKey?: string; projectName?: string }>;
}

type BuildProjection = ((input: ProjectionInput) => unknown) & { original?: BuildProjection; loads?: number };
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
}
// An entry in Metro's module registry.
interface MetroModule {
  isInitialized?: boolean;
  publicModule?: { exports?: Record<string, unknown> };
}

/**
 * Puts the named sidebar groups first, in the given order; the rest keep Paseo's order below
 * them. Only groups the sidebar already shows move, so the host filter still applies.
 */
export function orderProjects<Input extends ProjectionInput>(input: Input, names: readonly string[]): Input {
  if (names.length === 0) return input;
  const rank = new Map(names.map((name, index) => [name, index]));
  const ordered = input.projects.filter((project) => rank.has(project.projectName));
  if (ordered.length === 0) return input;
  // Stable, so two same-named groups on one host keep Paseo's order between them.
  ordered.sort((a, b) => rank.get(a.projectName)! - rank.get(b.projectName)!);
  return { ...input, projects: [...ordered, ...input.projects.filter((project) => !rank.has(project.projectName))] };
}

/**
 * Leaves the named groups, and those whose name starts with 0, out of the sidebar with their chats,
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

// shortcut: the plugin SDK has no sidebar order API, so this finds the app's own modules among
// those Metro has loaded: buildSidebarProjection, which lays out the sidebar's groups and its
// keyboard shortcuts, and the sidebar order store, nudged so the sidebar lays itself out again.
// Breaks if Paseo renames either or Metro stops keeping modules in a Map; switch to an SDK call
// once one exists.
export function findSidebarModules(): SidebarModules {
  const metroRequire = (globalThis as { __r?: (id: unknown) => unknown }).__r;
  if (typeof metroRequire !== "function") throw new Error("Metro runtime not found");
  // Metro's require starts with modules.get(id), so asking for an id no module has hands over the
  // registry Map. The probe answers as an already loaded module, so Metro runs no module code and
  // takes no error path, which would be fatal in a release build on iOS and Android.
  const probe = Symbol("workspace-order");
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
  let projection: ProjectionModule | undefined;
  let orderStore: OrderStore | undefined;
  // Only modules that have already run: requiring another one would run its code early.
  for (const module of modules.values()) {
    const exports = module?.isInitialized ? module.publicModule?.exports : undefined;
    if (!exports) continue;
    if (typeof exports.buildSidebarProjection === "function") projection = exports as unknown as ProjectionModule;
    const store = exports.useSidebarOrderStore as Partial<OrderStore> | undefined;
    if (typeof store?.setState === "function" && Array.isArray(store.getState?.().pinnedWorkspaceOrder)) {
      orderStore = store as OrderStore;
    }
  }
  if (!projection) throw new Error("Paseo sidebar layout not found");
  if (!orderStore) throw new Error("Paseo sidebar order not found");
  return { projection, orderStore };
}

// The sidebar recomputes its layout only when its inputs change; a fresh copy of the saved
// pinned order is one of them and changes nothing else.
function relayout(orderStore: OrderStore) {
  orderStore.setState({ pinnedWorkspaceOrder: [...orderStore.getState().pinnedWorkspaceOrder] });
}

// The app loads this plugin once per host that has it installed, so loads share one wrapper and
// the last one to unload restores the original.
export function patch({ projection, orderStore }: SidebarModules): () => void {
  let wrapper = projection.buildSidebarProjection;
  if (!wrapper.original) {
    const original = wrapper;
    const layout = (input: ProjectionInput) => original(orderProjects(hideProjects(input, readHidden()), readOrder()));
    wrapper = Object.assign(layout, { original, loads: 0 });
    projection.buildSidebarProjection = wrapper;
  }
  wrapper.loads! += 1;
  const unsubscribeOrder = subscribeOrder(() => relayout(orderStore));
  const unsubscribeHidden = subscribeHidden(() => relayout(orderStore));
  relayout(orderStore);
  let unloaded = false;
  return () => {
    if (unloaded) return;
    unloaded = true;
    unsubscribeOrder();
    unsubscribeHidden();
    wrapper.loads! -= 1;
    if (wrapper.loads === 0) projection.buildSidebarProjection = wrapper.original!;
    relayout(orderStore);
  };
}
