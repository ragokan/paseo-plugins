import type { PluginClientContext } from "@getpaseo/plugin/client";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const console: { warn(...args: unknown[]): void };
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

// The fields of Paseo's WorkspaceStructureProject this plugin reads or rewrites.
export interface StructureProject {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  hosts: Array<{ serverId: string }>;
  workspaceKeys: string[];
}

type BuildProjects = ((input: unknown) => StructureProject[]) & { original?: BuildProjects; loads?: number };
interface StructureModule {
  buildWorkspaceStructureProjects: BuildProjects;
}
// An entry in Metro's module registry.
interface MetroModule {
  isInitialized?: boolean;
  publicModule?: { exports?: Partial<StructureModule> };
}

/**
 * Folds same-named projects from different hosts into one, the shape Paseo already uses for a git
 * remote cloned on several hosts. Input and output are sorted by name, so the merged project takes
 * its first member's place.
 */
export function mergeSameNamedProjects<P extends StructureProject>(projects: P[]): P[] {
  const byName = new Map<string, P[]>();
  for (const project of projects) {
    byName.set(project.projectName, [...(byName.get(project.projectName) ?? []), project]);
  }
  return Array.from(byName, ([name, group]) => {
    const serverIds = group.flatMap((project) => project.hosts.map((host) => host.serverId));
    // Paseo finds a project's folder by host, so two same-named projects on one host stay apart.
    if (group.length === 1 || new Set(serverIds).size !== serverIds.length) return group;
    const first = group[0]!;
    return [
      {
        ...first,
        viewKey: `merged:${name}`,
        projectKey: group.every((project) => project.projectKey === first.projectKey) ? first.projectKey : null,
        hosts: group.flatMap((project) => project.hosts),
        workspaceKeys: group.flatMap((project) => project.workspaceKeys),
      },
    ];
  }).flat();
}

// shortcut: the plugin SDK has no API for project grouping, so this finds the app's own
// workspace-structure module among the modules Metro has loaded and wraps
// buildWorkspaceStructureProjects, which the sidebar and the project pickers all call. Breaks if
// Paseo renames that function or Metro stops keeping modules in a Map; switch to an SDK call once
// one exists.
export function findStructureModule(): StructureModule {
  const metroRequire = (globalThis as { __r?: (id: unknown) => unknown }).__r;
  if (typeof metroRequire !== "function") throw new Error("Metro runtime not found");
  // Metro's require starts with modules.get(id), so asking for an id no module has hands over the
  // registry Map. The probe answers as an already loaded module, so Metro runs no module code and
  // takes no error path, which would be fatal in a release build on iOS and Android.
  const probe = Symbol("merge-projects");
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
  // Only modules that have already run: requiring another one would run its code early.
  for (const module of modules.values()) {
    const exports = module?.isInitialized ? module.publicModule?.exports : undefined;
    if (typeof exports?.buildWorkspaceStructureProjects === "function") return exports as StructureModule;
  }
  throw new Error("Paseo project grouping not found");
}

// The app loads this plugin once per host that has it installed, so loads share one wrapper and
// the last one to unload restores the original.
export function patch(module: StructureModule): () => void {
  let wrapper = module.buildWorkspaceStructureProjects;
  if (!wrapper.original) {
    const original = wrapper;
    wrapper = Object.assign((input: unknown) => mergeSameNamedProjects(original(input)), { original, loads: 0 });
    module.buildWorkspaceStructureProjects = wrapper;
  }
  wrapper.loads! += 1;
  let unloaded = false;
  return () => {
    if (unloaded) return;
    unloaded = true;
    wrapper.loads! -= 1;
    if (wrapper.loads === 0) module.buildWorkspaceStructureProjects = wrapper.original!;
  };
}

export default function contribute(_client: PluginClientContext) {
  let unpatch: (() => void) | undefined;
  let retry: unknown;
  let attempts = 0;
  // The grouping module may not have loaded yet when the plugin starts, so look again for a while.
  const attach = () => {
    try {
      unpatch = patch(findStructureModule());
    } catch (error) {
      if (++attempts < 30) retry = setTimeout(attach, 1000);
      else console.warn("[merge-projects]", error);
    }
  };
  attach();
  return () => {
    clearTimeout(retry);
    unpatch?.();
  };
}
