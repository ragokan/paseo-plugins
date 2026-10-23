import { readOrder, subscribeOrder } from "./order";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const document: { scripts: ArrayLike<{ src: string }> };
declare function fetch(url: string): Promise<{ text(): Promise<string> }>;

// The field of Paseo's SidebarProjectionInput this plugin rewrites.
export interface ProjectionInput {
  projects: Array<{ projectName: string }>;
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

// shortcut: the plugin SDK has no sidebar order API, so this finds the app's own modules in its
// Metro bundle: buildSidebarProjection, which lays out the sidebar's groups and its keyboard
// shortcuts, and the sidebar order store, nudged so the sidebar lays itself out again.
// Desktop/web only, and breaks if Paseo renames either; switch to an SDK call once one exists.
export async function findSidebarModules(): Promise<SidebarModules> {
  const bundle = Array.from(document.scripts).find((script) => script.src.includes("/_expo/static/js/"));
  if (!bundle) throw new Error("Paseo app bundle not found");
  const source = await (await fetch(bundle.src)).text();
  const metroRequire = (globalThis as { __r?: (id: number) => Record<string, unknown> }).__r;
  const moduleWith = (marker: string) => {
    const start = source.indexOf(marker);
    const end = source.indexOf("\n", start);
    // Each Metro module is one line ending in `},<moduleId>,[<deps>]);`.
    const moduleId = start < 0 ? undefined : /,(\d+),\[[\d,]*\]\);$/.exec(source.slice(start, end < 0 ? undefined : end))?.[1];
    return moduleId && metroRequire ? metroRequire(Number(moduleId)) : undefined;
  };
  const projection = moduleWith(".buildSidebarProjection=function") as Partial<ProjectionModule> | undefined;
  const orderStore = moduleWith('"useSidebarOrderStore",{enumerable')?.useSidebarOrderStore as Partial<OrderStore> | undefined;
  if (typeof projection?.buildSidebarProjection !== "function") throw new Error("Paseo sidebar layout not found");
  if (typeof orderStore?.setState !== "function" || !Array.isArray(orderStore.getState?.().pinnedWorkspaceOrder)) {
    throw new Error("Paseo sidebar order not found");
  }
  return { projection: projection as ProjectionModule, orderStore: orderStore as OrderStore };
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
    wrapper = Object.assign((input: ProjectionInput) => original(orderProjects(input, readOrder())), { original, loads: 0 });
    projection.buildSidebarProjection = wrapper;
  }
  wrapper.loads! += 1;
  const unsubscribe = subscribeOrder(() => relayout(orderStore));
  relayout(orderStore);
  let unloaded = false;
  return () => {
    if (unloaded) return;
    unloaded = true;
    unsubscribe();
    wrapper.loads! -= 1;
    if (wrapper.loads === 0) projection.buildSidebarProjection = wrapper.original!;
    relayout(orderStore);
  };
}
