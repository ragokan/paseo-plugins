import type { PluginClientContext, PluginIcon } from "@getpaseo/plugin/client";
import { pluginRoute, type AppModules, type InstalledPlugin } from "./app";

/** A plugin sidebar row, once across the hosts that have it, and the screen it opens. */
export interface SidebarTarget {
  key: string;
  title: string;
  icon: PluginIcon;
  pluginId: string;
  kind: "surface" | "sidebar";
  id: string;
  /** The hosts that have the plugin, in the registry's order. */
  serverIds: string[];
}

// A sidebar row is a component that decides what it opens. Paseo's plugins and this repository's
// open the screen with the row's id; a plugin with one screen can only open that one.
function screenFor(plugin: InstalledPlugin, itemId: string): string | null {
  if (plugin.surfaces.some((screen) => screen.id === itemId)) return itemId;
  return plugin.surfaces.length === 1 ? plugin.surfaces[0].id : null;
}

/** Every plugin sidebar row, header and footer, on every host, as the sidebar shows them: once each. */
export function sidebarTargets(plugins: readonly InstalledPlugin[]): SidebarTarget[] {
  const targets = new Map<string, SidebarTarget>();
  const add = (plugin: InstalledPlugin, key: string, target: Omit<SidebarTarget, "key" | "pluginId" | "serverIds">) => {
    const existing = targets.get(key);
    if (existing) {
      if (!existing.serverIds.includes(plugin.serverId)) existing.serverIds.push(plugin.serverId);
    } else targets.set(key, { ...target, key, pluginId: plugin.id, serverIds: [plugin.serverId] });
  };
  for (const plugin of plugins) {
    const title = (text: unknown) => plugin.i18n.resolve(text, plugin.locale);
    for (const item of plugin.legacySidebarItems ?? []) {
      add(plugin, `${plugin.id}/header/${item.id}`, { title: title(item.title), icon: item.icon, kind: "sidebar", id: item.id });
    }
    for (const section of ["header", "footer"] as const) {
      for (const item of plugin.sidebarItems[section]) {
        const screen = screenFor(plugin, item.id);
        if (screen) add(plugin, `${plugin.id}/${section}/${item.id}`, { title: title(item.title), icon: "PanelLeft", kind: "surface", id: screen });
      }
    }
  }
  return [...targets.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The route a target opens: on this copy's host when it has the plugin, else on the first that does. */
export function targetRoute(target: SidebarTarget, ownServerId: string | undefined) {
  const serverId = ownServerId && target.serverIds.includes(ownServerId) ? ownServerId : target.serverIds[0];
  return pluginRoute(serverId, target.pluginId, target.kind, target.id);
}

const signature = (target: SidebarTarget) => JSON.stringify([target.title, target.icon, target.kind, target.id]);

/**
 * A command per plugin sidebar row, kept in step with the plugins every host has. Paseo offers a
 * copy's commands only while its own host is selected, so every copy adds them.
 */
export function addSidebarCommands(client: PluginClientContext, app: AppModules): () => void {
  const registered = new Map<string, { id: string; signature: string; remove: () => void }>();
  const ids = new Map<string, string>();
  let latest = new Map<string, SidebarTarget>();
  let syncing = false;
  let again = false;
  let stopped = false;

  const open = (key: string, paseo: unknown) => {
    const target = latest.get(key);
    if (!target) throw new Error("That sidebar row is gone");
    const own = app.registry.getSnapshot().find((plugin) => plugin.paseo === paseo)?.serverId;
    app.router.push(targetRoute(target, own));
  };

  const register = (target: SidebarTarget) => {
    // Contribution ids are lowercase letters, digits and dashes; a sidebar row keeps its id here.
    let id = ids.get(target.key);
    if (!id) ids.set(target.key, (id = `open-${ids.size + 1}`));
    const remove = client.addCommandCenterItem({
      id,
      title: target.title,
      icon: target.icon,
      keywords: ["sidebar", "open", target.pluginId],
      context: "global",
      onSelect: ({ paseo }) => open(target.key, paseo),
    });
    registered.set(target.key, { id, signature: signature(target), remove });
  };

  // Each command added or removed makes the registry publish again, from inside this loop.
  const sync = () => {
    if (stopped) return;
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    try {
      do {
        again = false;
        const targets = sidebarTargets(app.registry.getSnapshot());
        latest = new Map(targets.map((target) => [target.key, target]));
        for (const [key, entry] of [...registered]) {
          const target = latest.get(key);
          if (target && signature(target) === entry.signature) continue;
          registered.delete(key);
          entry.remove();
        }
        for (const target of targets) if (!registered.has(target.key)) register(target);
      } while (again && !stopped);
    } finally {
      syncing = false;
    }
  };

  const unsubscribe = app.registry.subscribe(sync);
  sync();
  return () => {
    stopped = true;
    unsubscribe();
    for (const entry of registered.values()) entry.remove();
    registered.clear();
  };
}
