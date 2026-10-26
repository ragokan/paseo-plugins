import { cloneElement, isValidElement, type ReactNode } from "react";
import { guarded } from "./guard";
import { loadedExports, onModuleRun, type MetroModules } from "./sidebar";

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

type Fn = (...args: never[]) => unknown;
type Wrapper = Fn & { original?: Fn; loads?: number };

/**
 * Replaces a function a module or object holds with wrap(original); callers read it from there on every
 * call. The app loads this plugin once per host that has it, so loads share one wrapper, and the last
 * one to unload puts the original back.
 */
export function wrapExport<F extends Fn>(module: Record<string, unknown>, name: string, wrap: (original: F) => F): () => void {
  let wrapper = module[name] as Wrapper;
  if (!wrapper.original) {
    const original = wrapper;
    wrapper = Object.assign(wrap(original as F), { original, loads: 0 });
    module[name] = wrapper;
  }
  wrapper.loads = (wrapper.loads ?? 0) + 1;
  let unloaded = false;
  return () => {
    if (unloaded) return;
    unloaded = true;
    wrapper.loads! -= 1;
    if (wrapper.loads === 0 && module[name] === wrapper) module[name] = wrapper.original;
  };
}

// A sidebar row's subtitle items, as Paseo's selectMetaRowItems lists them: branch, project, host, then the rest.
interface MetaItem {
  kind: string;
}

/** The host first in a sidebar row's subtitle, so the machine shows before the folder. */
export function hostFirst<Item extends MetaItem>(items: Item[]): Item[] {
  const at = items.findIndex((item) => item.kind === "host");
  return at > 0 ? [items[at]!, ...items.slice(0, at), ...items.slice(at + 1)] : items;
}

/** Paseo's host badge, a server icon and the host's name, with the name alone when it shows one. */
export function withoutServerIcon(badge: unknown, showsName: boolean): unknown {
  if (!showsName || !isValidElement<{ children?: unknown }>(badge)) return badge;
  const children = badge.props.children;
  if (!Array.isArray(children) || children.length !== 2 || !children[1]) return badge;
  return cloneElement(badge, undefined, children[1] as ReactNode);
}

// Whether a node is, or holds within depth levels, the element with this testID.
function holds(node: unknown, testID: string, depth = 3): boolean {
  if (!isValidElement<{ testID?: string; children?: unknown }>(node)) return false;
  if (node.props.testID === testID) return true;
  const children = node.props.children;
  return depth > 0 && (Array.isArray(children) ? children : [children]).some((child) => holds(child, testID, depth - 1));
}

/** The New workspace form, whose first two fields are the project and the host, with the host first. */
export function hostPickerFirst(form: unknown): unknown {
  if (!isValidElement<{ children?: unknown }>(form)) return form;
  const children = form.props.children;
  if (!Array.isArray(children)) return form;
  const [project, host, ...rest] = children as ReactNode[];
  if (!holds(project, "new-workspace-project-picker-trigger") || !holds(host, "host-picker-trigger")) return form;
  return cloneElement(form, undefined, host, project, ...rest);
}

// The command palette's sections, as Paseo's buildContributionSections makes them: a result's score
// has fieldRank 0 when the query matched its title, 1 when it matched only its keywords.
interface PaletteResult {
  id: string;
  kind: string;
  score?: { fieldRank: number };
}
interface PaletteSection {
  id: string;
  band: number;
  rank: number;
  title?: string;
  results: PaletteResult[];
  score?: unknown;
}

/**
 * The command palette with Mark as done first when the query matches its title. Paseo ranks by
 * match first, so "done" puts the Labels › Done item, an exact match, above it, and plugin
 * commands below every built-in group besides. It moves into a section of its own that sorts
 * first, and the palette highlights it.
 */
export function markAsDoneFirst(sections: readonly PaletteSection[]): PaletteSection[] {
  for (const [index, section] of sections.entries()) {
    const result = section.results.find(
      (entry) => entry.kind === "contribution" && entry.id.endsWith(":mark-as-done") && entry.score?.fieldRank === 0,
    );
    if (!result) continue;
    const lead: PaletteSection = { id: `${section.id}:mark-as-done`, band: -1, rank: -1, results: [result], score: result.score };
    const rest = { ...section, results: section.results.filter((entry) => entry !== result) };
    return [lead, ...sections.slice(0, index), rest, ...sections.slice(index + 1)];
  }
  return [...sections];
}

// Paseo's plugin buttons, as its pluginButtonStore keeps them: header buttons and composer pills.
interface ButtonEntry {
  id: string;
  installation: { id: string };
  placement: string;
  button: { label?: string };
}
interface ButtonStore {
  entries: ButtonEntry[];
  publish(entries: ButtonEntry[]): void;
}

function isButtonStore(value: unknown): value is ButtonStore {
  const store = value as Partial<ButtonStore & { addComposerPill: unknown }> | null;
  return typeof store === "object" && store !== null && Array.isArray(store.entries) && typeof store.publish === "function" && typeof store.addComposerPill === "function";
}

// Paseo's button for each pill lowercased here, to put back when the tweak comes off.
const paseoButtons = new WeakMap<object, ButtonEntry["button"]>();

/** Shell Yeah's Run pill as "run", lowercase like the mcp pill beside it. The same array when nothing changes. */
export function lowercaseRunPill(entries: ButtonEntry[]): ButtonEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    const label = entry.button.label;
    if (entry.installation.id !== "shell-yeah" || entry.placement !== "composer" || entry.id !== "run") return entry;
    if (!label || label === label.toLowerCase()) return entry;
    changed = true;
    const button = { ...entry.button, label: label.toLowerCase() };
    paseoButtons.set(button, entry.button);
    return { ...entry, button };
  });
  return changed ? next : entries;
}

/** The pills with Paseo's labels again. */
export function restoreRunPill(entries: ButtonEntry[]): ButtonEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    const button = paseoButtons.get(entry.button);
    if (!button) return entry;
    changed = true;
    return { ...entry, button };
  });
  return changed ? next : entries;
}

// The pills already there: lowercase while publish is wrapped, as Paseo made them once it is not.
function relabelPills(store: ButtonStore) {
  const entries = guarded("run pill", store.entries, "original" in store.publish ? lowercaseRunPill : restoreRunPill);
  if (entries !== store.entries) store.publish(entries);
}

type SelectMetaRowItems = (input: unknown) => MetaItem[];
type HostBadge = (props: { badge: { showLabel: boolean } }) => unknown;
type UseNewWorkspaceForm = (input: unknown) => unknown;
type ProjectCommandCenterRows = (sections: PaletteSection[], sizes: unknown) => unknown;

// What each tweak wraps: the module that exports the function, found by its export. Each runs Paseo's
// own as it is and guards only its change, so a hook's calls stay the same if the change fails.
const TWEAKS = [
  {
    // Sidebar rows: the machine before the folder.
    find: (exports: Record<string, unknown>) => typeof exports.selectMetaRowItems === "function",
    name: "selectMetaRowItems",
    wrap: (original: SelectMetaRowItems) => (input: unknown) => guarded("host first", original(input), hostFirst),
    rows: true,
  },
  {
    // The host's name without the server icon, in the sidebar rows and wherever Paseo shows the badge.
    find: (exports: Record<string, unknown>) => typeof exports.HostBadge === "function" && "HOST_BADGE_ICON_SIZE" in exports,
    name: "HostBadge",
    // Called as a function, the original's hooks run as this component's.
    wrap: (original: HostBadge) =>
      function HostBadge(props: { badge: { showLabel: boolean } }) {
        return guarded("host badge", original(props), (badge) => withoutServerIcon(badge, props.badge.showLabel));
      },
    rows: true,
  },
  {
    // New workspace: the host picker before the project picker. Paseo calls the hook on every render.
    find: (exports: Record<string, unknown>) => typeof exports.useNewWorkspaceForm === "function",
    name: "useNewWorkspaceForm",
    wrap: (original: UseNewWorkspaceForm) =>
      function useNewWorkspaceForm(input: unknown) {
        return guarded("host picker first", original(input), hostPickerFirst);
      },
    rows: false,
  },
  {
    // The command palette: Mark as done before the label of the same name. Paseo calls it on every query.
    find: (exports: Record<string, unknown>) =>
      typeof exports.projectCommandCenterRows === "function" && typeof exports.buildContributionSections === "function",
    name: "projectCommandCenterRows",
    wrap: (original: ProjectCommandCenterRows) =>
      function projectCommandCenterRows(sections: PaletteSection[], sizes: unknown) {
        return original(guarded("Mark as done first", sections, markAsDoneFirst), sizes);
      },
    rows: false,
  },
  {
    // Shell Yeah's composer pill as "run". Every change to the plugin buttons goes through the store's
    // publish, so pills added or updated later are lowercased too.
    find: (exports: Record<string, unknown>) => isButtonStore(exports.pluginButtonStore),
    target: (exports: Record<string, unknown>) => exports.pluginButtonStore as ButtonStore & Record<string, unknown>,
    name: "publish",
    wrap: (original: ButtonStore["publish"]) =>
      function publish(this: ButtonStore, entries: ButtonEntry[]) {
        return original.call(this, guarded("run pill", entries, lowercaseRunPill));
      },
    rows: false,
    // Pills added before the plugin started are relabeled as it starts, and given back Paseo's as it stops.
    refresh: (store: Record<string, unknown>) => relabelPills(store as unknown as ButtonStore),
  },
] as const;

/**
 * Sidebar rows keep what they drew until their host badge changes, and Paseo makes the badges again
 * only when its host list changes, so a fresh copy of the list redraws every row.
 */
export function redrawRows() {
  const store = Reflect.get(globalThis, "__paseoHostRuntimeStore") as { hosts?: unknown; emitHostList?: () => void } | undefined;
  if (!Array.isArray(store?.hosts) || typeof store.emitHostList !== "function") return;
  store.hosts = [...store.hosts];
  store.emitHostList();
}

/**
 * Applies each tweak to the module it wraps: those the app has loaded now, those it has not run yet,
 * like the New workspace screen's, as they run, before anything draws with them, and those Metro does
 * not have yet as it is looked for again. Returns a function that takes them off.
 */
export function applyTweaks(modules: MetroModules): () => void {
  const removers = new Map<string, () => void>();
  let timer: unknown;
  let wait = 1000;
  let stopListening = () => {};
  const found = () => removers.size === TWEAKS.length;
  // The tweaks one module's exports take; whether the sidebar rows need drawing again.
  const tweakModule = (exports: Record<string, unknown>) => {
    let rows = false;
    for (const tweak of TWEAKS) {
      if (removers.has(tweak.name) || !tweak.find(exports)) continue;
      const target = "target" in tweak ? tweak.target(exports) : exports;
      const unwrap = wrapExport(target, tweak.name, tweak.wrap as unknown as (original: Fn) => Fn);
      const refresh = "refresh" in tweak ? () => tweak.refresh(target) : () => {};
      refresh();
      removers.set(tweak.name, () => {
        unwrap();
        refresh();
      });
      rows ||= tweak.rows;
    }
    return rows;
  };
  const look = () => {
    let redraw = false;
    for (const exports of loadedExports(modules)) {
      if (found()) break;
      redraw = tweakModule(exports) || redraw;
    }
    if (redraw) redrawRows();
    if (found()) return stopListening();
    timer = setTimeout(look, wait);
    wait = Math.min(wait * 2, 30_000);
  };
  look();
  if (!found()) {
    stopListening = onModuleRun(modules, (exports) => {
      // The module is running inside the app's require, maybe mid-render, so the rows draw after.
      if (tweakModule(exports)) setTimeout(redrawRows, 0);
      if (!found()) return;
      stopListening();
      clearTimeout(timer);
    });
  }
  return () => {
    clearTimeout(timer);
    stopListening();
    for (const remove of removers.values()) remove();
    if (TWEAKS.some((tweak) => tweak.rows && removers.has(tweak.name))) redrawRows();
  };
}
