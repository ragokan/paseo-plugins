// Runs the plugin against the installed Paseo app bundle: finds the sidebar modules, then lays out
// a sidebar with Paseo's real buildSidebarProjection, unpatched and patched. Re-run after Paseo updates:
//   npm run check [path/to/index-<hash>.js]
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";

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

// Plugin modules, compiled the way the app loads them.
const pluginModules = new Map();
function loadPlugin(name) {
  if (!pluginModules.has(name)) {
    const { outputText } = ts.transpileModule(readFileSync(new URL(`client/${name}.ts`, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const module = { exports: {} };
    pluginModules.set(name, module);
    new Function("require", "module", "exports", outputText)((id) => loadPlugin(id.replace("./", "")), module, module.exports);
  }
  return pluginModules.get(name).exports;
}
const { saveOrder } = loadPlugin("order");
const { findSidebarModules, patch } = loadPlugin("sidebar");

// Minimal Metro runtime over the bundle's own modules, so the check runs Paseo's real code. A module
// is one line, except a few vendored ones that span several until `},<id>,[<deps>]);`.
const lines = new Map();
let pending = null;
for (const line of bundle.split("\n")) {
  if (pending === null && !line.startsWith("__d(")) continue;
  pending = pending === null ? line : `${pending}\n${line}`;
  const match = /\},(\d+),\[[\d,]*\]\);$/.exec(line);
  if (match) {
    lines.set(Number(match[1]), pending);
    pending = null;
  }
}
const modules = new Map();
function metroRequire(id) {
  if (!modules.has(id)) {
    let definition;
    new Function("__d", lines.get(id))((factory, _id, deps) => (definition = { factory, deps }));
    const module = { exports: {} };
    modules.set(id, module);
    definition.factory(globalThis, metroRequire, metroRequire, metroRequire, module, module.exports, definition.deps);
  }
  return modules.get(id).exports;
}
metroRequire.importDefault = (id) => metroRequire(id).default;
metroRequire.importAll = metroRequire;
const moduleWith = (marker) => {
  const start = bundle.indexOf(marker);
  return metroRequire(Number(/,(\d+),\[[\d,]*\]\);$/.exec(bundle.slice(start, bundle.indexOf("\n", start)))[1]));
};

async function lookup(source) {
  const requestedIds = [];
  globalThis.document = { scripts: [{ src: "app://other.js" }, { src: "app:///_expo/static/js/web/index.js" }] };
  globalThis.fetch = async () => ({ text: async () => source });
  globalThis.__r = (id) => (requestedIds.push(id), metroRequire(id));
  return { found: await findSidebarModules(), requestedIds };
}

const { found, requestedIds } = await lookup(bundle);
assert.match(lines.get(requestedIds[0]), /\.buildSidebarProjection=function/);
assert.match(lines.get(requestedIds[1]), /"useSidebarOrderStore",\{enumerable/);
await assert.rejects(lookup("__d(function(){},1,[]);"), /sidebar layout not found/);
const { projection, orderStore } = found;
const { applyStoredOrdering } = moduleWith(".applyStoredOrdering=function");

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
const layout = ({ hosts, storedOrder }) => {
  const projects = applyStoredOrdering({ items: groupsFor(hosts), storedOrder, getKey: (p) => p.viewKey });
  return projection.buildSidebarProjection({
    projects,
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
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
assert.deepEqual(
  layout({ hosts: [BOX], storedOrder: [] }).shortcutModel.shortcutTargets.map((target) => target.workspaceId),
  ["ragokan-chat", "pasode-chat", "coding-chat", "warp-chat"],
);

// Saving an order makes the sidebar lay itself out again.
const before = orderStore.getState().pinnedWorkspaceOrder;
saveOrder(["warp"]);
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["warp", "coding", "dev", "pasode", "ragokan"]);

// A second host's copy wraps nothing new, and the order stays until every copy unloads.
unpatch();
unpatch();
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] }))[0], "warp");
unpatchSecondHost();
assert.equal(projection.buildSidebarProjection, original);
assert.deepEqual(names(layout({ hosts: ALL, storedOrder: [] })), ["coding", "dev", "pasode", "ragokan", "warp"]);
console.log(`ok: sidebar layout is module ${requestedIds[0]}, order store module ${requestedIds[1]} in ${bundlePath}`);
