import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { loadedExports, metroModules, type MetroModules } from "./sidebar";
import { listenForKeys, onMac, pagePath, type KeyPress } from "./web";

declare const console: { warn(...args: unknown[]): void };

// Paseo's own bindings for ⌘⇧D on macOS and Ctrl+Shift+D elsewhere, both voice mode's.
const PASEO_COMBOS = ["Cmd+Shift+D", "Ctrl+Shift+D"];

/**
 * ⌘⇧D on macOS, Ctrl+Shift+D elsewhere, as Paseo pairs its own shortcuts. D is the letter, as in
 * Paseo, or the key in D's place on a layout without Latin letters.
 */
export function isShortcut(event: KeyPress, mac: boolean): boolean {
  const key = event.key.toLowerCase();
  const isD = key === "d" || (!/^[a-z]$/.test(key) && event.code === "KeyD");
  if (!isD || !event.shiftKey || event.altKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// The fields of Paseo's keyboard bindings this plugin reads or rewrites.
interface Binding {
  combo: string;
  parsedChord: unknown[];
}
type ParseRoute = (pathname: string) => { serverId: string; workspaceId: string } | null;
interface PaseoKeys {
  bindings: Binding[];
  parseRoute: ParseRoute;
}

// shortcut: the plugin SDK has no keyboard shortcuts, so this finds Paseo's default bindings and its
// workspace route parser among the modules the app has loaded. Switch to SDK calls once they exist.
function findPaseoKeys(modules: MetroModules): PaseoKeys {
  let bindings: Binding[] | undefined;
  let parseRoute: ParseRoute | undefined;
  for (const exports of loadedExports(modules)) {
    if (typeof exports.buildEffectiveBindings === "function" && Array.isArray(exports.DEFAULT_BINDINGS)) {
      bindings = exports.DEFAULT_BINDINGS as Binding[];
    }
    if (typeof exports.parseHostWorkspaceRouteFromPathname === "function") {
      parseRoute = exports.parseHostWorkspaceRouteFromPathname as ParseRoute;
    }
  }
  if (!bindings) throw new Error("Paseo keyboard shortcuts not found");
  if (!parseRoute) throw new Error("Paseo workspace routes not found");
  return { bindings, parseRoute };
}

/**
 * Takes Paseo's own bindings off the keys until the returned function gives them back. Paseo matches
 * presses against these same objects, unless a binding was given other keys in Settings → Shortcuts,
 * so this applies at once.
 */
function takeKeys(bindings: Binding[]): () => void {
  const taken = bindings
    .filter((binding) => PASEO_COMBOS.includes(binding.combo) && binding.parsedChord.length > 0)
    .map((binding) => ({ binding, chord: binding.parsedChord }));
  for (const { binding } of taken) binding.parsedChord = [];
  return () => {
    for (const { binding, chord } of taken) binding.parsedChord = chord;
  };
}

type Run = (workspaceId: string) => Promise<void>;
interface Copy {
  serverId: string;
  run: Run;
}
interface Shared {
  copies: Set<Copy>;
  stop?: () => void;
}

// The app loads a copy of this plugin for every host that has it, all in one JavaScript realm. One
// listener serves them all, each copy the workspaces of its own host. Bump the version when this
// shape changes.
const SHARED = Symbol.for("ragokan/paseo-plugins/tweaks/shortcut@1");
function shared(): Shared {
  const realm = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (realm[SHARED] ??= { copies: new Set() });
}

// On a workspace's page the keys are the plugin's; the copy for the workspace's host runs, once per press.
function start(state: Shared): () => void {
  const paseo = findPaseoKeys(metroModules());
  const giveBack = takeKeys(paseo.bindings);
  const mac = onMac();
  const stopListening = listenForKeys((event) => {
    if (event.isComposing || !isShortcut(event, mac)) return;
    const path = pagePath();
    const route = path === null ? null : paseo.parseRoute(path);
    if (!route) return;
    event.preventDefault();
    event.stopPropagation();
    const copy = [...state.copies].find((other) => other.serverId === route.serverId);
    if (event.repeat || !copy) return;
    copy.run(route.workspaceId).catch((error: unknown) => console.warn("[tweaks] ⌘⇧D left the workspace as it is:", error));
  });
  return () => {
    stopListening();
    giveBack();
  };
}

/**
 * Runs run with the open workspace's id when ⌘⇧D is pressed on a workspace of this copy's host, on
 * the desktop and web apps. Returns a function that stops.
 */
export function addShortcut(client: PluginClientContext, run: Run): () => void {
  if (Platform.OS !== "web") return () => {};
  const state = shared();
  let copy: Copy | undefined;
  let stopped = false;
  // Started in a promise so an app without the host list warns instead of throwing.
  Promise.resolve()
    .then(() => client.paseo.hosts.list())
    .then(({ self }) => {
      if (stopped) return;
      copy = { serverId: self.serverId, run };
      state.copies.add(copy);
      state.stop ??= start(state);
    })
    .catch((error: unknown) => console.warn("[tweaks] ⌘⇧D stays Paseo's", error));
  return () => {
    stopped = true;
    if (!copy || !state.copies.delete(copy) || state.copies.size > 0) return;
    state.stop?.();
    state.stop = undefined;
  };
}
