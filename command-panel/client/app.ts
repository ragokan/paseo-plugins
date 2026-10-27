import type { PluginIcon } from "@getpaseo/plugin/client";

// shortcut: the plugin SDK opens only a plugin's own screens, lists no other plugin's sidebar rows and
// cannot update plugins, so this plugin borrows the app's own modules for those: its plugin registry,
// its router and its connection to each host. Breaks if Paseo renames them; switch to SDK calls once
// they exist.

type Text = unknown;
interface SidebarItem {
  id: string;
  title: Text;
}
/** The fields of Paseo's InstalledPlugin this plugin reads. */
export interface InstalledPlugin {
  id: string;
  serverId: string;
  /** The installation's Paseo client, the `paseo` its commands receive. */
  paseo: unknown;
  locale: string;
  i18n: { resolve(text: Text, locale: string): string };
  surfaces: ReadonlyArray<{ id: string }>;
  sidebarItems: { header: readonly SidebarItem[]; footer: readonly SidebarItem[] };
  /** addSidebarItem rows, which open their own route. Missing once Paseo drops them. */
  legacySidebarItems?: ReadonlyArray<SidebarItem & { icon: PluginIcon }>;
}
export interface PluginRegistry {
  getSnapshot(): readonly InstalledPlugin[];
  subscribe(listener: () => void): () => void;
}
export interface Router {
  push(href: string): void;
}
export interface AppModules {
  registry: PluginRegistry;
  router: Router;
}

// An entry in Metro's module registry.
interface MetroModule {
  isInitialized?: boolean;
  publicModule?: { exports?: Record<string, unknown> };
}

/** Metro's module registry. The same probe as the tweaks plugin's: it runs no module code. */
function metroModules(): ReadonlyMap<unknown, MetroModule> {
  const metroRequire = (globalThis as { __r?: (id: unknown) => unknown }).__r;
  if (typeof metroRequire !== "function") throw new Error("Metro runtime not found");
  // Metro's require starts with modules.get(id), so asking for an id no module has hands over the
  // registry Map. The probe answers as an already loaded module, so Metro takes no error path, which
  // would be fatal in a release build on iOS and Android.
  const probe = Symbol("command-panel");
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

function read(exports: Record<string, unknown>, key: string): unknown {
  // Exports are getters; one that throws is not what this plugin looks for.
  try {
    return exports[key];
  } catch {
    return undefined;
  }
}

const isFunction = (value: unknown, ...keys: string[]) =>
  typeof value === "object" && value !== null && keys.every((key) => typeof (value as Record<string, unknown>)[key] === "function");

/**
 * Paseo's plugin registry, every host's installed plugins, and expo-router's router, among the
 * modules the app has run. Both run before any plugin does.
 */
export function findAppModules(): AppModules {
  let registry: PluginRegistry | undefined;
  let router: Router | undefined;
  for (const module of metroModules().values()) {
    const exports = module?.isInitialized ? module.publicModule?.exports : undefined;
    if (!exports) continue;
    const candidateRegistry = read(exports, "pluginRegistry");
    if (isFunction(candidateRegistry, "getSnapshot", "subscribe")) registry = candidateRegistry as PluginRegistry;
    const candidateRouter = read(exports, "router");
    if (isFunction(candidateRouter, "push", "replace", "navigate", "canGoBack", "dismissTo")) router = candidateRouter as Router;
  }
  if (!registry) throw new Error("Paseo plugin registry not found");
  if (!router) throw new Error("Paseo router not found");
  return { registry, router };
}

/** The route Paseo gives a plugin screen, as `buildPluginSurfaceRoute` builds it. */
export function pluginRoute(serverId: string, pluginId: string, kind: "surface" | "sidebar", id: string) {
  return `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginId)}/${kind}/${encodeURIComponent(id)}`;
}

/** The plugin update calls of the app's daemon client, which the CLI's `paseo plugin update` makes too. */
export interface UpdateClient {
  previewPluginUpdates(input: { pluginId?: string }): Promise<UpdatePreview[]>;
  applyPluginUpdates(proposals: unknown[]): Promise<UpdateResult[]>;
}
type Revision = { kind: "git"; commit: string } | { kind: "npm"; version: string };
export interface UpdatePreview {
  id: string;
  outcome: "update" | "current" | "installed-newer" | "local" | "error";
  current?: { currentRevision?: string };
  target?: Revision;
  proposal?: unknown;
  error?: string;
}
export interface UpdateResult {
  id: string;
  outcome: "updated" | "error";
  error?: string;
  warning?: string;
}
export interface HostRuntimeStore {
  getHosts(): readonly { serverId: string; label: string }[];
  getSnapshot(serverId: string): { connectionStatus: string; client: UpdateClient | null } | null;
}

/** The app's host runtime store, a singleton on globalThis, as the mark-all-read plugin finds it. */
export function findHostRuntimeStore(): HostRuntimeStore {
  const store = Reflect.get(globalThis, "__paseoHostRuntimeStore") as Partial<HostRuntimeStore> | undefined;
  if (typeof store?.getHosts !== "function" || typeof store.getSnapshot !== "function") {
    throw new Error("Paseo host runtime not found");
  }
  return store as HostRuntimeStore;
}
