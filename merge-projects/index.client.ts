import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const document: { scripts: ArrayLike<{ src: string }> };
declare function fetch(url: string): Promise<{ text(): Promise<string> }>;
declare const console: { warn(...args: unknown[]): void };

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
// workspace-structure module in its Metro bundle and wraps buildWorkspaceStructureProjects, which
// the sidebar and the project pickers all call. Desktop/web only, and breaks if Paseo renames that
// function; switch to an SDK call once one exists.
export async function findStructureModule(): Promise<StructureModule> {
  const bundle = Array.from(document.scripts).find((script) => script.src.includes("/_expo/static/js/"));
  if (!bundle) throw new Error("Paseo app bundle not found");
  const source = await (await fetch(bundle.src)).text();
  const start = source.indexOf(".buildWorkspaceStructureProjects=function");
  const end = source.indexOf("\n", start);
  // Each Metro module is one line ending in `},<moduleId>,[<deps>]);`.
  const moduleId = start < 0 ? undefined : /,(\d+),\[[\d,]*\]\);$/.exec(source.slice(start, end < 0 ? undefined : end))?.[1];
  const metroRequire = (globalThis as { __r?: (id: number) => Partial<StructureModule> }).__r;
  const module = moduleId && metroRequire ? metroRequire(Number(moduleId)) : undefined;
  if (typeof module?.buildWorkspaceStructureProjects !== "function") {
    throw new Error("Paseo project grouping not found");
  }
  return module as StructureModule;
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
  // The module lookup reads the web bundle, so iOS and Android keep Paseo's own grouping.
  if (Platform.OS !== "web") return () => {};
  const unpatch = findStructureModule().then(patch, (error) => {
    console.warn("[merge-projects]", error);
    return () => {};
  });
  return async () => (await unpatch)();
}
