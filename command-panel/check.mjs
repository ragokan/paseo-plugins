// Runs the plugin against the installed Paseo app bundle: finds the app's plugin registry and router
// through the bundle's own Metro runtime, turns the sidebar rows of plugins on two hosts into commands
// with Paseo's real registry publishing them, opens them on the right host, and updates fake hosts'
// plugins. Re-run after Paseo updates:
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

// Plugin modules, compiled to CommonJS; relative imports load the same way, packages from node_modules.
const stubs = { "react-native": { Text: "Text" }, "@getpaseo/plugin/client/ui": {} };
const pluginModules = new Map();
function loadPlugin(file) {
  if (!pluginModules.has(file)) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    });
    const module = { exports: {} };
    pluginModules.set(file, module);
    const localRequire = (specifier) => {
      if (specifier in stubs) return stubs[specifier];
      if (!specifier.startsWith(".")) return require(specifier);
      const base = path.join(path.dirname(file), specifier);
      return loadPlugin([".ts", ".tsx"].map((extension) => base + extension).find((candidate) => existsSync(path.join(root, candidate))));
    };
    new Function("require", "module", "exports", outputText)(localRequire, module, module.exports);
  }
  return pluginModules.get(file).exports;
}
const { findAppModules, findHostRuntimeStore, pluginRoute } = loadPlugin("client/app.ts");
const { addSidebarCommands, sidebarTargets } = loadPlugin("client/sidebar.ts");
const { readRun, subscribeRun, updateAllPlugins } = loadPlugin("client/updates.ts");

assert.throws(findAppModules, /Metro runtime not found/);
assert.throws(findHostRuntimeStore, /host runtime not found/);

// The bundle's own Metro runtime, as the tweaks check loads it.
const lines = bundle.split("\n");
const mapGet = Map.prototype.get;
const fatal = [];
globalThis.ErrorUtils = { reportFatalError: (error) => fatal.push(error) };
globalThis.__METRO_GLOBAL_PREFIX__ = "";
(0, eval)(lines.find((line) => line.includes("Requiring unknown module")));
const metroDefine = globalThis.__d;
const metroRequire = globalThis.__r;
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
const findModule = (needle) => {
  const found = [...moduleTexts].filter(([, text]) => text.includes(needle));
  assert.equal(found.length, 1, `expected one module with ${needle}`);
  return found[0];
};
const [registryId] = findModule('"pluginRegistry",{enumerable');
const [routerId] = findModule("e.router={navigate:");
const [routesId] = findModule(".buildPluginSurfaceRoute=");
const [, evaluateText] = findModule(".runPluginClientBundle=");

// The registry module pulls in the app's UI, which does not run here. Run Paseo's real registry
// class over stubs of what it imports: each installation gets its own Paseo client, and a plugin's
// bundle is a function this check picks by name.
const bundles = new Map();
let clients = 0;
const registryImports = [
  { c: () => [] },
  { PluginTranslationRuntime: class { locale = "en"; resolve = (text) => text; subscribe = () => () => {}; dispose() {} } },
  { i18n: { language: "en", on() {}, off() {} } },
  { useSyncExternalStore() {} },
  { QueryClient: class { clear() {} } },
  { createPaseoApi: () => ({ client: ++clients, dispose: async () => {} }) },
  { assertPluginCompatibility() {} },
  { resolveAppVersion: () => "0.13.1" },
  { createPluginClientRuntime: (installation) => installation },
  { runPluginClientBundle: (_id, name, installation, onChange) => bundles.get(name)(installation, onChange) },
];
const ran = new Set();
globalThis.__d = (factory, id, deps) =>
  metroDefine(
    id === registryId
      ? function (global, _require, importDefault, importAll, module, exports, dependencyMap) {
          ran.add(id);
          const stubRequire = (dependency) => registryImports[dependencyMap.indexOf(dependency)];
          return factory.call(this, global, stubRequire, importDefault, importAll, module, exports, dependencyMap);
        }
      : function (...args) {
          ran.add(id);
          return factory.apply(this, args);
        },
    id,
    deps,
  );
for (const text of moduleTexts.values()) (0, eval)(text);

// Not loaded yet: the lookup finds nothing and loads nothing.
assert.throws(findAppModules, /plugin registry not found/);
assert.equal(ran.size, 0);

// What the app has loaded by the time a plugin starts.
const { pluginRegistry } = metroRequire(registryId);
const { router } = metroRequire(routerId);
const routes = metroRequire(routesId);
const ranByApp = new Set(ran);
const app = findAppModules();
assert.equal(app.registry, pluginRegistry, "finds Paseo's plugin registry");
assert.equal(app.router, router, "finds expo-router's router");
assert.deepEqual(ran, ranByApp, "the lookup ran no module code");
assert.deepEqual(fatal, []);
assert.equal(Map.prototype.get, mapGet);

// Routes as Paseo builds them, so a command lands where the sidebar row does.
for (const [serverId, pluginId, kind, id] of [["srv_box", "zerosub", "sidebar", "accounts"], ["srv mini/1", "all", "surface", "mcps"]]) {
  assert.equal(pluginRoute(serverId, pluginId, kind, id), routes.buildPluginSurfaceRoute(serverId, pluginId, { kind, id }));
}

// What Paseo checks when a plugin adds a command.
assert.ok(evaluateText.includes("=/^[a-z][a-z0-9-]*$/,"), "Paseo's contribution id rule changed");
const contributionId = /^[a-z][a-z0-9-]*$/;
function pluginContext(installation, onChange) {
  let setup = true;
  const register = (items, item) => {
    items.push(item);
    if (!setup) onChange();
    return () => {
      const index = items.indexOf(item);
      if (index === -1) return;
      items.splice(index, 1);
      onChange();
    };
  };
  return {
    context: {
      paseo: installation.paseo,
      addCommandCenterItem(item) {
        assert.match(item.id, contributionId);
        assert.ok(!installation.commandCenterItems.some((other) => other.id === item.id), `duplicate command ${item.id}`);
        assert.ok(item.title && item.icon && typeof item.onSelect === "function");
        return register(installation.commandCenterItems, item);
      },
    },
    done: () => (setup = false),
  };
}
const component = () => null;
const sidebarPlugin = ({ screens = [], header = [], footer = [], legacy = [] }) => (installation) => {
  installation.surfaces.push(...screens.map((id) => ({ id, title: id, Component: component })));
  installation.sidebarItems.header.push(...header.map(([id, title]) => ({ id, title, Component: component })));
  installation.sidebarItems.footer.push(...footer.map(([id, title]) => ({ id, title, Component: component })));
  installation.legacySidebarItems.push(...legacy.map(([id, title, icon]) => ({ id, title, icon, surface: id })));
  return { cleanup: () => {} };
};
const stops = new Map();
bundles.set("command-panel", (installation, onChange) => {
  const { context, done } = pluginContext(installation, onChange);
  const stop = addSidebarCommands(context, app);
  done();
  stops.set(installation.serverId, stop);
  return { cleanup: stop };
});
bundles.set("all", sidebarPlugin({ screens: ["mcps", "main", "updates"], header: [["mcps", "Manage MCP servers"], ["main", "Machine"]] }));
bundles.set("zerosub", sidebarPlugin({ screens: ["accounts"], legacy: [["accounts", "Accounts (ZeroSub)", "Users"]] }));
bundles.set("browseros-neo", sidebarPlugin({ screens: ["main"], header: [["main", "BrowserOS Neo"]] }));
bundles.set("devices", sidebarPlugin({ screens: ["list", "detail"], footer: [["list", "Devices"], ["popover", "Pick a device"]] }));
const install = (serverId, ids) =>
  pluginRegistry.installCatalog(serverId, ids.map((id) => ({ id, clientBundle: id })), { client: { invokePluginRpc() {} }, audio: {} });

const MINI = "srv_mini";
const BOX = "srv_box";
install(MINI, ["all", "command-panel", "devices"]);
install(BOX, ["all", "browseros-neo", "command-panel", "zerosub"]);
const commandsOn = (serverId) => {
  const installation = pluginRegistry.getSnapshot().find((plugin) => plugin.serverId === serverId && plugin.id === "command-panel");
  return installation.commandCenterItems;
};
const titles = (serverId) => commandsOn(serverId).map((item) => item.title).sort();
// Every row on every host, once, with no command for a row whose screen it cannot tell.
const ROWS = ["Accounts (ZeroSub)", "BrowserOS Neo", "Devices", "Machine", "Manage MCP servers"];
assert.deepEqual(titles(MINI), ROWS, "the first host's copy lists the second host's rows too");
assert.deepEqual(titles(BOX), ROWS, "and the other way round");
assert.ok(commandsOn(BOX).every((item) => item.context === "global"));
assert.equal(commandsOn(BOX).find((item) => item.title === "Accounts (ZeroSub)").icon, "Users", "a legacy row keeps its icon");

// A command opens its row's screen on the selected host, the copy's own, when that host has the plugin.
const pushed = [];
const originalPush = router.push;
router.push = (href) => pushed.push(href);
const select = (serverId, title) => {
  const installation = pluginRegistry.getSnapshot().find((plugin) => plugin.serverId === serverId && plugin.id === "command-panel");
  installation.commandCenterItems.find((item) => item.title === title).onSelect({ context: "global", paseo: installation.paseo });
};
select(BOX, "Manage MCP servers");
select(MINI, "Manage MCP servers");
select(MINI, "Accounts (ZeroSub)");
select(BOX, "Devices");
select(BOX, "BrowserOS Neo");
router.push = originalPush;
assert.deepEqual(pushed, [
  pluginRoute(BOX, "all", "surface", "mcps"),
  pluginRoute(MINI, "all", "surface", "mcps"),
  pluginRoute(BOX, "zerosub", "sidebar", "accounts"),
  pluginRoute(MINI, "devices", "surface", "list"),
  pluginRoute(BOX, "browseros-neo", "surface", "main"),
]);

// Commands follow the plugins: a plugin removed from a host takes its rows with it, unless another host still has it.
install(BOX, ["all", "command-panel", "zerosub"]);
assert.deepEqual(titles(MINI), ["Accounts (ZeroSub)", "Devices", "Machine", "Manage MCP servers"]);
install(MINI, ["all", "browseros-neo", "command-panel", "devices"]);
assert.deepEqual(titles(BOX), ROWS, "added back from the other host");
const ids = commandsOn(BOX).map((item) => item.id);
assert.equal(new Set(ids).size, ids.length);

// A copy that stops takes its commands with it, and no longer follows the registry.
stops.get(MINI)();
assert.deepEqual(commandsOn(MINI), []);
install(BOX, ["all", "command-panel", "devices", "zerosub"]);
assert.deepEqual(commandsOn(MINI), []);
assert.deepEqual(titles(BOX), ROWS);
assert.deepEqual(sidebarTargets([]), []);

// The app internals Update All Plugins borrows: the host runtime store on globalThis, and the daemon
// client's update calls, the ones `paseo plugin update` makes.
const [, storeModule] = findModule('"HostRuntimeStore",{enumerable');
const key = /(\w+)="__paseoHostRuntimeStore"/.exec(storeModule)?.[1];
assert.ok(key, "the host runtime store's global key changed");
assert.match(storeModule, /\}getHosts\(\)\{return this\.hosts\}/);
assert.match(storeModule, /\}getSnapshot\((\w+)\)\{return this\.controllers\.get\(\1\)\?\.getSnapshot\(\)\?\?null\}/);
const [, clientModule] = findModule("async previewPluginUpdates(");
assert.match(clientModule, /async previewPluginUpdates\(\w+=\{\}\)\{this\.requirePluginUpdates\(\)/);
assert.match(clientModule, /async applyPluginUpdates\(\w+\)\{this\.requirePluginUpdates\(\)/);

// Fake hosts: one with two updates of which one fails, one up to date with a local folder, one whose
// check fails, one offline.
const preview = (id, outcome, extra = {}) => ({ id, outcome, links: [], ...extra });
const hosts = {
  [MINI]: {
    label: "ragmini ",
    preview: [
      preview("all", "update", { current: { currentRevision: "5d077a840db1029e85903a677b76ebc07845819e" }, target: { kind: "git", commit: "41e4d0d0000000000000000000000000000000aa" }, proposal: { id: "all" } }),
      preview("zerosub", "update", { current: { currentRevision: "1.3.0" }, target: { kind: "npm", version: "1.4.0" }, proposal: { id: "zerosub" } }),
      preview("shell-yeah", "current"),
    ],
    apply: [{ id: "all", outcome: "updated" }, { id: "zerosub", outcome: "error", error: "integrity mismatch" }],
  },
  [BOX]: { label: "ragdevbox", preview: [preview("all", "current"), preview("browseros-neo", "local")] },
  srv_old: { label: "old", preview: new Error("Update the host to review plugin updates.") },
  srv_off: { label: "", offline: true },
};
const applied = [];
const store = {
  getHosts: () => Object.entries(hosts).map(([serverId, { label }]) => ({ serverId, label })),
  getSnapshot(serverId) {
    const host = hosts[serverId];
    if (host.offline) return { connectionStatus: "offline", client: null };
    return {
      connectionStatus: "online",
      client: {
        async previewPluginUpdates(input) {
          assert.deepEqual(input, {}, "every plugin, at its newest");
          if (host.preview instanceof Error) throw host.preview;
          return host.preview;
        },
        async applyPluginUpdates(proposals) {
          applied.push([serverId, proposals.map((proposal) => proposal.id)]);
          return host.apply;
        },
      },
    };
  },
};
const states = [];
const unsubscribe = subscribeRun(() => states.push(readRun().hosts.find((host) => host.serverId === MINI).state));
const running = updateAllPlugins(store);
assert.equal(readRun().finished, false);
await updateAllPlugins(store);
assert.equal(readRun().finished, false, "a second press while it runs starts nothing");
await running;
unsubscribe();
assert.deepEqual(applied, [[MINI, ["all", "zerosub"]]], "only what has a newer version, once");
assert.deepEqual([...new Set(states)], ["checking", "updating", "done"]);
const run = readRun();
assert.equal(run.finished, true);
const byHost = Object.fromEntries(run.hosts.map((host) => [host.serverId, host]));
assert.equal(byHost[MINI].label, "ragmini");
assert.deepEqual(byHost[MINI].updated, [{ id: "all", from: "5d077a8", to: "41e4d0d" }]);
assert.deepEqual(byHost[MINI].failed, [{ id: "zerosub", error: "integrity mismatch" }]);
assert.deepEqual({ state: byHost[BOX].state, updated: byHost[BOX].updated, local: byHost[BOX].local }, { state: "done", updated: [], local: ["browseros-neo"] });
assert.deepEqual({ state: byHost.srv_old.state, error: byHost.srv_old.error }, { state: "failed", error: "Update the host to review plugin updates." });
assert.deepEqual({ label: byHost.srv_off.label, state: byHost.srv_off.state, error: byHost.srv_off.error }, { label: "srv_off", state: "failed", error: "Offline" });

// A reloaded copy, as after updating this plugin, sees the same run.
pluginModules.clear();
assert.equal(loadPlugin("client/updates.ts").readRun(), run);

console.log(`ok: ${ROWS.length} sidebar rows as commands on 2 hosts, routes match Paseo's, updates across ${Object.keys(hosts).length} hosts`);
