// Runs the plugin against the installed Paseo app bundle: finds the sidebar modules through the
// bundle's own Metro runtime, lays out a sidebar with Paseo's real buildSidebarProjection, unpatched,
// ordered and with workspaces hidden, and hides workspaces through fake hosts' settings. Re-run after
// Paseo updates:
//   npm run check [path/to/index-<hash>.js]
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundleDir = "/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/";
// The app bundle is the largest index-*.js; the others are small async chunks.
const bundlePath =
  process.argv[2] ??
  readdirSync(bundleDir)
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => bundleDir + name)
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
const bundle = readFileSync(bundlePath, "utf8");

// The plugin's order lives in the app's localStorage, as does Paseo's, which its order store writes.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { localStorage: globalThis.localStorage };

// Plugin modules, compiled to CommonJS; relative imports load the same way, packages from node_modules.
const pluginModules = new Map();
function loadPlugin(file) {
  if (!pluginModules.has(file)) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const module = { exports: {} };
    pluginModules.set(file, module);
    const localRequire = (specifier) => {
      if (!specifier.startsWith(".")) return require(specifier);
      const base = path.join(path.dirname(file), specifier);
      return loadPlugin([".ts", ".tsx"].map((extension) => base + extension).find((candidate) => existsSync(path.join(root, candidate))));
    };
    new Function("require", "module", "exports", outputText)(localRequire, module, module.exports);
  }
  return pluginModules.get(file).exports;
}
const { readOrder, saveOrder } = loadPlugin("client/order.ts");
const { findSidebarModules, hideProjects, patch } = loadPlugin("client/sidebar.ts");
const { joinHiddenWorkspaces, readHidden, setHidden } = loadPlugin("client/hidden.ts");
const { default: contributeServer } = loadPlugin("index.server.ts");

assert.throws(findSidebarModules, /Metro runtime not found/);

// The bundle's own Metro runtime (the same one the iOS and Android builds use), with an ErrorUtils
// like React Native's, whose fatal report crashes a release build.
const lines = bundle.split("\n");
const mapGet = Map.prototype.get;
const fatal = [];
globalThis.ErrorUtils = { reportFatalError: (error) => fatal.push(error) };
globalThis.__METRO_GLOBAL_PREFIX__ = "";
(0, eval)(lines.find((line) => line.includes("Requiring unknown module")));
const metroDefine = globalThis.__d;
const metroRequire = globalThis.__r;

// Defines every module, counting which module factories run. A module is one line, except a few
// vendored ones that span several until `},<id>,[<deps>]);`.
const moduleTexts = new Map();
let pending = null;
for (const line of lines) {
  if (pending === null && !line.startsWith("__d(")) continue;
  pending = pending === null ? line : `${pending}\n${line}`;
  const match = /\},(\d+),\[[\d,]*\]\);$/.exec(line);
  if (match) {
    moduleTexts.set(Number(match[1]), pending);
    pending = null;
  }
}
const ran = new Set();
globalThis.__d = (factory, id, deps) =>
  metroDefine(function (...args) {
    ran.add(id);
    return factory.apply(this, args);
  }, id, deps);
for (const text of moduleTexts.values()) (0, eval)(text);
const idOf = (marker) => [...moduleTexts].find(([, text]) => text.includes(marker))[0];

// Not loaded yet: the lookup finds nothing and loads nothing.
assert.throws(findSidebarModules, /sidebar layout not found/);
assert.equal(ran.size, 0);

// What the app has loaded by the time the plugin starts.
const projection = metroRequire(idOf(".buildSidebarProjection=function"));
const { useSidebarOrderStore } = metroRequire(idOf('"useSidebarOrderStore",{enumerable'));
const { applyStoredOrdering } = metroRequire(idOf(".applyStoredOrdering=function"));
const ranByApp = new Set(ran);
const found = findSidebarModules();
assert.equal(found.projection, projection);
assert.equal(found.orderStore, useSidebarOrderStore);
assert.deepEqual(ran, ranByApp, "the lookup ran no module code");
assert.deepEqual(fatal, []);
assert.equal(Map.prototype.get, mapGet);
const { orderStore } = found;

// Two hosts. Paseo keys a sidebar group by view key, and merge-projects gives a group on both hosts
// the key `merged:<name>` only while both are shown; with the host filter on one host it is that
// host's own key.
const MINI = "srv_mini", BOX = "srv_box";
const group = (name, serverIds, viewKey) => ({
  viewKey,
  projectName: name,
  projectKind: "non_git",
  iconWorkingDir: `/home/${name}`,
  hosts: serverIds.map((serverId) => ({ serverId, iconWorkingDir: `/home/${name}` })),
  workspaces: serverIds.map((serverId) => ({
    workspaceKey: `${serverId}:${name}-chat`,
    serverId,
    workspaceId: `${name}-chat`,
    projectViewKey: viewKey,
    projectName: name,
    projectKind: "non_git",
    workspaceKind: "directory",
    name: `${name} chat`,
  })),
});
const groupsFor = (hosts) => {
  const both = hosts.length === 2;
  const key = (name, serverId) => (both ? `merged:${name}` : `host:${serverId}:/home/${name}`);
  // Paseo's default order is by name.
  return [
    group("coding", hosts, key("coding", hosts[0])),
    ...(hosts.includes(MINI) ? [group("dev", [MINI], `host:${MINI}:/home/dev`)] : []),
    ...(hosts.includes(BOX) ? [group("pasode", [BOX], `host:${BOX}:/home/pasode`)] : []),
    group("ragokan", hosts, key("ragokan", hosts[0])),
    ...(hosts.includes(BOX) ? [group("warp", [BOX], `host:${BOX}:/home/warp`)] : []),
  ];
};
// What the sidebar shows: Paseo applies its saved group order, then lays the sidebar out.
const layout = ({ hosts, storedOrder, pinned = [] }) => {
  const projects = applyStoredOrdering({ items: groupsFor(hosts), storedOrder, getKey: (p) => p.viewKey });
  return projection.buildSidebarProjection({
    projects,
    pinnedKeys: { pinnedWorkspaceKeys: pinned, pinnedAtByKey: Object.fromEntries(pinned.map((key) => [key, "2026-10-23"])) },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map(),
    projectNamesByViewKey: new Map(projects.map((p) => [p.viewKey, p.projectName])),
    groupMode: "project",
    pinnedCollapsed: false,
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    t: (key) => key,
  });
};
const names = (result) => result.pinnedGroups.unpinnedProjects.map((p) => p.projectName);
const ALL = [MINI, BOX];

// The bug: with every host shown you drag the groups into ragokan, pasode, coding, dev, warp.
// Switch the host filter to BOX and ragokan and coding have other keys, which the saved order does
// not know, so they fall back to Paseo's name order.
const dragged = layout({ hosts: ALL, storedOrder: [] }).pinnedGroups.unpinnedProjects;
const storedOrder = ["ragokan", "pasode", "coding", "dev", "warp"].map((name) => dragged.find((p) => p.projectName === name).viewKey);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder })), ["ragokan", "pasode", "coding", "dev", "warp"]);
assert.deepEqual(names(layout({ hosts: [BOX], storedOrder })), ["coding", "pasode", "ragokan", "warp"]);

const original = projection.buildSidebarProjection;
const unpatch = patch({ projection, orderStore });
const unpatchSecondHost = patch({ projection, orderStore });

// Ordered by name, the groups keep your order on every host filter, ahead of the rest, which keep
// Paseo's order. dev is only on MINI and stays out of BOX's sidebar.
saveOrder(["ragokan", "pasode", "coding"]);
for (const order of [storedOrder, []]) {
  assert.deepEqual(names(layout({ hosts: ALL, storedOrder: order })).slice(0, 3), ["ragokan", "pasode", "coding"]);
  assert.deepEqual(names(layout({ hosts: [BOX], storedOrder: order })), ["ragokan", "pasode", "coding", "warp"]);
  assert.deepEqual(names(layout({ hosts: [MINI], storedOrder: order })), ["ragokan", "coding", "dev"]);
}
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["ragokan", "pasode", "coding", "dev", "warp"]);
// Keyboard shortcuts walk the same order.
const shortcuts = (result) => result.shortcutModel.shortcutTargets.map((target) => target.workspaceId);
assert.deepEqual(shortcuts(layout({ hosts: [BOX], storedOrder: [] })), ["ragokan-chat", "pasode-chat", "coding-chat", "warp-chat"]);

// Saving an order makes the sidebar lay itself out again.
let before = orderStore.getState().pinnedWorkspaceOrder;
saveOrder(["warp"]);
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["warp", "coding", "dev", "pasode", "ragokan"]);

// Hidden workspaces live in each host's settings, read and written through Paseo's settings RPC.
const server = [];
contributeServer({ registerSettings: (definition) => server.push(definition) });
assert.deepEqual(server.map((definition) => definition.id), ["hidden-workspaces"]);
assert.deepEqual(server[0].schema.parse({}), { names: [] });

function fakeHost(label, hidden = []) {
  const host = { stored: { names: hidden }, revision: 1, writes: 0, down: false, conflictOnce: false, observers: [], released: false };
  host.client = {
    async rpc(contract, input) {
      if (host.down) throw new Error(`${label} is unreachable`);
      if (contract.name === "settings.hidden-workspaces.read") return { status: "ready", revision: String(host.revision), values: host.stored };
      assert.equal(contract.name, "settings.hidden-workspaces.write");
      if (host.conflictOnce) {
        // Another app saved first.
        host.conflictOnce = false;
        host.revision += 1;
      }
      if (input.revision !== String(host.revision)) return { status: "conflict", error: "stale revision" };
      host.stored = input.values;
      host.revision += 1;
      host.writes += 1;
      return { status: "saved", revision: String(host.revision), values: host.stored };
    },
    paseo: {
      observeEvents(events) {
        assert.deepEqual(events, ["status.plugin_settings_changed"]);
        return {
          subscribe(observer) {
            host.observers.push(observer);
            queueMicrotask(() => observer.snapshot({ subscriptionId: "sub" }));
            return () => {};
          },
          release: async () => void (host.released = true),
        };
      },
    },
  };
  host.changed = (settingsId) => {
    for (const observer of host.observers) {
      observer.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "workspace-order", settingsId } });
    }
  };
  return host;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const hidden = () => [...readHidden()].sort();

// Each copy of the plugin brings its host's list, and the app hides them all.
const mini = fakeHost("ragmini", ["7326-plugin-timeline-kind"]);
const box = fakeHost("ragdevbox");
const air = fakeHost("ragair", ["6434-claude-settings"]);
const leave = new Map([mini, box, air].map((host) => [host, joinHiddenWorkspaces(host.client)]));
await settle();
assert.deepEqual(hidden(), ["6434-claude-settings", "7326-plugin-timeline-kind"]);

// Hiding saves on every host. One saves in between and costs another read; one is unreachable,
// which the error names while the others keep the change.
air.conflictOnce = true;
box.down = true;
await assert.rejects(setHidden("7555-markdown-table", true), /Could not save on 1 of 3 hosts: ragdevbox is unreachable/);
assert.deepEqual(mini.stored.names, ["7326-plugin-timeline-kind", "7555-markdown-table"]);
assert.deepEqual(air.stored.names, ["6434-claude-settings", "7555-markdown-table"]);
assert.ok(readHidden().has("7555-markdown-table"));
box.down = false;
const writes = [mini.writes, air.writes];
await setHidden("7555-markdown-table", true);
assert.deepEqual(box.stored.names, ["7555-markdown-table"]);
assert.deepEqual([mini.writes, air.writes], writes, "hosts that already hide it are left alone");

// Showing takes it off every host.
await setHidden("7326-plugin-timeline-kind", false);
assert.deepEqual(mini.stored.names, ["7555-markdown-table"]);
assert.deepEqual(hidden(), ["6434-claude-settings", "7555-markdown-table"]);

// Another app saving on a host: this app reads that host again, for this setting only.
air.stored = { names: [...air.stored.names, "7324-codex-multi-file"] };
air.revision += 1;
air.changed("features");
await settle();
assert.ok(!readHidden().has("7324-codex-multi-file"));
air.changed("hidden-workspaces");
await settle();
assert.ok(readHidden().has("7324-codex-multi-file"));

// A copy that stops takes its host's list with it.
leave.get(air)();
assert.ok(air.released);
assert.deepEqual(hidden(), ["7555-markdown-table"]);

// A hidden group leaves the sidebar on every host filter, with its chats, pinned ones too, and its
// shortcuts; the order skips it. Hiding lays the sidebar out again.
saveOrder(["ragokan", "pasode", "coding"]);
before = orderStore.getState().pinnedWorkspaceOrder;
await setHidden("pasode", true);
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["ragokan", "coding", "dev", "warp"]);
assert.deepEqual(names(layout({ hosts: [BOX], storedOrder: storedOrder })), ["ragokan", "coding", "warp"]);
assert.deepEqual(shortcuts(layout({ hosts: [BOX], storedOrder: [] })), ["ragokan-chat", "coding-chat", "warp-chat"]);
const pinned = layout({ hosts: [BOX], storedOrder: [], pinned: [`${BOX}:pasode-chat`, `${BOX}:warp-chat`] }).pinnedGroups.pinnedChats;
assert.deepEqual(pinned.map((chat) => chat.workspaceId), ["warp-chat"]);
await setHidden("pasode", false);
assert.deepEqual(names(layout({ hosts: [BOX], storedOrder: [] })), ["ragokan", "pasode", "coding", "warp"]);

// Status grouping takes chats from the workspace entries; a hidden group's go, by key or by name.
const entries = new Map([
  ["a", { projectViewKey: "k-pasode", projectName: "pasode" }],
  ["b", { projectViewKey: "k-coding", projectName: "coding" }],
  ["c", { projectViewKey: "prj_old", projectName: "pasode" }],
]);
const projects = [
  { projectName: "pasode", viewKey: "k-pasode" },
  { projectName: "coding", viewKey: "k-coding" },
];
const statusInput = hideProjects({ projects, workspaceEntriesByKey: entries }, new Set(["pasode"]));
assert.deepEqual(statusInput.projects.map((p) => p.projectName), ["coding"]);
assert.deepEqual([...statusInput.workspaceEntriesByKey.keys()], ["b"]);
assert.equal(hideProjects({ projects, workspaceEntriesByKey: entries }, new Set(["dev"])).projects, projects);

// iOS and Android: no localStorage, so no order, and nothing throws.
delete globalThis.localStorage;
assert.deepEqual(readOrder(), []);
globalThis.localStorage = globalThis.window.localStorage;

// A second host's copy wraps nothing new, and the patch stays until every copy unloads.
saveOrder(["warp"]);
unpatch();
unpatch();
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] }))[0], "warp");
unpatchSecondHost();
assert.equal(projection.buildSidebarProjection, original);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["coding", "dev", "pasode", "ragokan", "warp"]);
for (const stop of leave.values()) stop();
console.log(`ok: sidebar layout, order store and hiding in ${bundlePath}`);
