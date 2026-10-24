// Runs the plugin against the installed Paseo app bundle: finds the sidebar modules through the
// bundle's own Metro runtime, lays out a sidebar with Paseo's real buildSidebarProjection, unpatched,
// with workspaces hidden and grouped by status with Waiting and Idle, saves the hidden workspaces
// and those marked as done in fake hosts' settings, and follows fake hosts' agents. Re-run after
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

// Paseo's order store writes the app's localStorage.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { localStorage: globalThis.localStorage };

// Plugin modules, compiled to CommonJS; relative imports load the same way, packages from node_modules.
// The entry's React Native and its page are stubbed out, as on iOS, where the page is not added.
const stubs = {
  "react-native": { Platform: { OS: "ios" }, View: "View" },
  "./client/screen": {},
};
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
const { findSidebarModules, hideProjects, patch } = loadPlugin("client/sidebar.ts");
const { joinWorkspaceSettings, readDone, readHidden, setHidden } = loadPlugin("client/hosts.ts");
const { joinAgents, readWaiting, waitingWorkspaces } = loadPlugin("client/agents.ts");
const { addMarkAsDone } = loadPlugin("index.client.tsx");
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
const ranByApp = new Set(ran);
const found = findSidebarModules();
assert.equal(found.projection, projection);
assert.equal(found.orderStore, useSidebarOrderStore);
assert.equal(found.buildShortcuts, metroRequire(idOf(".buildSidebarShortcutSections=")).buildSidebarShortcutSections);
assert.deepEqual(ran, ranByApp, "the lookup ran no module code");
assert.deepEqual(fatal, []);
assert.equal(Map.prototype.get, mapGet);
const { orderStore } = found;

// Two hosts. Paseo shows a group per host, so coding and ragokan, on both, show twice.
const MINI = "srv_mini", BOX = "srv_box";
const ON = { [MINI]: ["coding", "dev", "ragokan"], [BOX]: ["coding", "pasode", "ragokan", "warp"] };
const group = (name, serverId, viewKey = `host:${serverId}:/home/${name}`) => ({
  viewKey,
  projectName: name,
  projectKind: "non_git",
  iconWorkingDir: `/home/${name}`,
  hosts: [{ serverId, iconWorkingDir: `/home/${name}` }],
  workspaces: [
    {
      workspaceKey: `${serverId}:${name}-chat`,
      serverId,
      workspaceId: `${name}-chat`,
      projectViewKey: viewKey,
      projectName: name,
      projectKind: "non_git",
      workspaceKind: "directory",
      name: `${name} chat`,
    },
  ],
});
// Paseo's default order is by name.
const groupsFor = (hosts) =>
  ["coding", "dev", "pasode", "ragokan", "warp"].flatMap((name) => hosts.filter((serverId) => ON[serverId].includes(name)).map((serverId) => group(name, serverId)));
const layout = ({ hosts, pinned = [], extra = [] }) => {
  const projects = [...groupsFor(hosts), ...extra];
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
const shortcuts = (result) => result.shortcutModel.shortcutTargets.map((target) => target.workspaceId);
const ALL = [MINI, BOX];
assert.deepEqual(names(layout({ hosts: ALL })), ["coding", "coding", "dev", "pasode", "ragokan", "ragokan", "warp"]);

const original = projection.buildSidebarProjection;
const unpatch = patch(found);
const unpatchSecondHost = patch(found);

// The hidden workspaces live in each host's settings, read and written through Paseo's settings RPC.
// It is the record workspace-order kept, so its hidden list and marks carry over; its order goes.
const server = [];
contributeServer({ registerSettings: (definition) => server.push(definition) });
assert.deepEqual(server.map((definition) => definition.id), ["workspaces"]);
assert.deepEqual(server[0].schema.parse({}), { hidden: [], done: {} });
assert.deepEqual(server[0].schema.parse({ hidden: ["dev"], order: ["warp"], orderSavedAt: 5, done: { w: 1 } }), { hidden: ["dev"], done: { w: 1 } });

function fakeHost(label, stored = {}) {
  const host = {
    stored: { hidden: [], done: {}, ...stored },
    revision: 1,
    writes: 0,
    down: false,
    conflictOnce: false,
    observers: [],
    released: false,
    commands: [],
    agentEntries: [],
    agentRequests: [],
    agentObservers: [],
    agentsReleased: false,
  };
  host.client = {
    async rpc(contract, input) {
      if (host.down) throw new Error(`${label} is unreachable`);
      if (contract.name === "settings.workspaces.read") return { status: "ready", revision: String(host.revision), values: host.stored };
      assert.equal(contract.name, "settings.workspaces.write");
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
    addCommandCenterItem(item) {
      host.commands.push(item);
      return () => host.commands.splice(host.commands.indexOf(item), 1);
    },
    paseo: {
      agents: {
        async list(options) {
          host.agentRequests.push(options);
          return {
            entries: host.agentEntries.map((agent) => ({ agent })),
            pageInfo: { hasMore: false },
            subscriptionId: "agents",
            subscription: {
              subscribe(observer) {
                host.agentObservers.push(observer);
                return () => {};
              },
              release: async () => void (host.agentsReleased = true),
            },
          };
        },
      },
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
  // Another app saving on this host, and the event the host sends for it.
  host.save = (values) => {
    host.stored = { ...host.stored, ...values };
    host.revision += 1;
  };
  host.changed = (settingsId) => {
    for (const observer of host.observers) {
      observer.update({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "tweaks", settingsId } });
    }
  };
  return host;
}
// After every pending promise; not a timer, since the Idle checks fake those.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const hidden = () => [...readHidden()].sort();

// Each copy of the plugin brings its host's settings; a name any host hides is hidden. ragmini's
// record is one workspace-order saved, order and all.
const mini = fakeHost("ragmini", { hidden: ["7326-plugin-timeline-kind"], order: ["warp"], orderSavedAt: 5 });
const box = fakeHost("ragdevbox");
const air = fakeHost("ragair", { hidden: ["6434-claude-settings"] });
const leave = new Map([mini, box, air].map((host) => [host, joinWorkspaceSettings(host.client)]));
await settle();
assert.deepEqual(hidden(), ["6434-claude-settings", "7326-plugin-timeline-kind"]);

// Hiding saves on every host. One host saves in between and costs another read; one is
// unreachable, which the error names while the others keep the change.
air.conflictOnce = true;
box.down = true;
await assert.rejects(setHidden("7555-markdown-table", true), /Could not save on 1 of 3 hosts: ragdevbox is unreachable/);
assert.deepEqual(mini.stored, { hidden: ["7326-plugin-timeline-kind", "7555-markdown-table"], done: {} }, "the old order goes with the next save");
assert.deepEqual(air.stored.hidden, ["6434-claude-settings", "7555-markdown-table"]);
assert.ok(readHidden().has("7555-markdown-table"));
box.down = false;
const writes = [mini.writes, air.writes];
await setHidden("7555-markdown-table", true);
assert.deepEqual(box.stored.hidden, ["7555-markdown-table"]);
assert.deepEqual([mini.writes, air.writes], writes, "hosts that already hide it are left alone");

// Showing takes it off every host.
await setHidden("7326-plugin-timeline-kind", false);
assert.deepEqual(mini.stored.hidden, ["7555-markdown-table"]);
assert.deepEqual(hidden(), ["6434-claude-settings", "7555-markdown-table"]);

// Another app saving on a host: this app reads that host again, for this setting only.
air.save({ hidden: [...air.stored.hidden, "7324-codex-multi-file"] });
air.changed("features");
await settle();
assert.ok(!readHidden().has("7324-codex-multi-file"));
air.changed("workspaces");
await settle();
assert.ok(readHidden().has("7324-codex-multi-file"));

// A copy that stops takes its host's settings with it.
leave.get(air)();
leave.delete(air);
assert.ok(air.released);
assert.deepEqual(hidden(), ["7555-markdown-table"]);

// A hidden group leaves the sidebar whichever hosts it shows, with its chats, pinned ones too, and
// its shortcuts. Hiding lays the sidebar out again.
let before = orderStore.getState().pinnedWorkspaceOrder;
await setHidden("pasode", true);
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(names(layout({ hosts: ALL })), ["coding", "coding", "dev", "ragokan", "ragokan", "warp"]);
assert.deepEqual(names(layout({ hosts: [BOX] })), ["coding", "ragokan", "warp"]);
assert.deepEqual(shortcuts(layout({ hosts: [BOX] })), ["coding-chat", "ragokan-chat", "warp-chat"]);
const pinned = layout({ hosts: [BOX], pinned: [`${BOX}:pasode-chat`, `${BOX}:warp-chat`] }).pinnedGroups.pinnedChats;
assert.deepEqual(pinned.map((chat) => chat.workspaceId), ["warp-chat"]);
await setHidden("pasode", false);
assert.deepEqual(names(layout({ hosts: [BOX] })), ["coding", "pasode", "ragokan", "warp"]);
// Hiding goes by name, so a name on two hosts leaves the sidebar from both.
await setHidden("coding", true);
assert.deepEqual(names(layout({ hosts: ALL })), ["dev", "pasode", "ragokan", "ragokan", "warp"]);
await setHidden("coding", false);

// A name starting with a digit is always hidden, picked or not, with its shortcuts.
const numbered = [group("3608-overlays-close-on-settings", BOX, `remote:github.com/getpaseo/paseo#3608`), group("0-scratch", BOX)];
assert.ok(numbered.every((p) => !readHidden().has(p.projectName)));
assert.deepEqual(names(layout({ hosts: [BOX], extra: numbered })), ["coding", "pasode", "ragokan", "warp"]);
assert.deepEqual(shortcuts(layout({ hosts: [BOX], extra: numbered })), ["coding-chat", "pasode-chat", "ragokan-chat", "warp-chat"]);

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
const zero = hideProjects(
  {
    projects: [...projects, { projectName: "0-scratch", viewKey: "k-zero" }],
    workspaceEntriesByKey: new Map([["z", { projectViewKey: "prj_zero", projectName: "0-scratch" }]]),
  },
  new Set(),
);
assert.deepEqual(zero.projects.map((p) => p.projectName), ["pasode", "coding"]);
assert.equal(zero.workspaceEntriesByKey.size, 0);

// Grouped by status, a workspace Paseo puts in Done waits a day in Idle, just above Done, newest
// first like Done. Keyboard shortcuts follow, skipping a collapsed group, pinned chats first.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
const t0 = realNow();
const timers = [];
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, ms) => {
  const timer = { callback, ms, cleared: false };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => void (timer && (timer.cleared = true));
const waiting = () => timers.filter((timer) => !timer.cleared);
const ROWS = [
  ["review", "attention", 3],
  ["build", "running", 1],
  ["fix-login", "done", 2],
  ["old-docs", "done", 30],
  ["never", "done", null],
  ["recent", "done", 0.5],
];
const statusLayout = ({ rows = ROWS, pinned = [], collapsed = [], pinnedCollapsed = false } = {}) => {
  const projects = groupsFor([BOX]);
  const coding = projects.find((p) => p.projectName === "coding").viewKey;
  const entries = rows.map(([id, bucket, hoursAgo]) => ({
    workspaceKey: `${BOX}:${id}`,
    serverId: BOX,
    workspaceId: id,
    projectViewKey: coding,
    projectName: "coding",
    name: id,
    statusBucket: bucket,
    statusEnteredAt: hoursAgo === null ? null : new Date(t0 - hoursAgo * HOUR),
  }));
  return projection.buildSidebarProjection({
    projects,
    pinnedKeys: { pinnedWorkspaceKeys: pinned, pinnedAtByKey: Object.fromEntries(pinned.map((key) => [key, "2026-10-23"])) },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map(entries.map((entry) => [entry.workspaceKey, entry])),
    projectNamesByViewKey: new Map(projects.map((p) => [p.viewKey, p.projectName])),
    groupMode: "status",
    pinnedCollapsed,
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(collapsed),
    t: (key) => key,
  });
};
const statusGroups = (result) => result.workspaceGroups.map((g) => [g.key, g.label, g.rows.map((row) => row.workspaceId)]);
const DONE = "sidebar.statusBucket.done";
let result = statusLayout({ pinned: [`${BOX}:warp-chat`] });
assert.deepEqual(statusGroups(result), [
  ["attention", "sidebar.statusBucket.readyToReview", ["review"]],
  ["running", "sidebar.statusBucket.working", ["build"]],
  ["idle", "Idle", ["recent", "fix-login"]],
  ["done", DONE, ["old-docs", "never"]],
]);
assert.deepEqual(result.workspaceGroups[2].leading, { kind: "status", bucket: "done" });
assert.deepEqual(shortcuts(result), ["warp-chat", "review", "build", "recent", "fix-login", "old-docs", "never"]);
assert.equal(result.shortcutModel.shortcutIndexByWorkspaceKey.get(`${BOX}:fix-login`), 5);
assert.deepEqual(shortcuts(statusLayout({ collapsed: ["idle"] })), ["review", "build", "old-docs", "never"]);
assert.deepEqual(shortcuts(statusLayout({ collapsed: ["done"], pinned: [`${BOX}:warp-chat`], pinnedCollapsed: true })), ["review", "build", "recent", "fix-login"]);
// With every Done workspace in Idle, there is no Done group, as Paseo leaves out an empty one.
assert.deepEqual(statusGroups(statusLayout({ rows: [["recent", "done", 0.5]] })), [["idle", "Idle", ["recent"]]]);
// Nothing waiting: Paseo's own layout, and no timer.
const settled = statusLayout({ rows: [["old-docs", "done", 30], ["build", "running", 1]] });
assert.deepEqual(statusGroups(settled), [["running", "sidebar.statusBucket.working", ["build"]], ["done", DONE, ["old-docs"]]]);
assert.deepEqual(waiting(), []);

// The sidebar lays itself out again when the next one has waited its day, and it moves to Done.
statusLayout();
assert.equal(waiting().length, 1);
// A second after it turns Done, less the few milliseconds since t0.
const delay = waiting()[0].ms - 22 * HOUR;
assert.ok(delay > 500 && delay <= 1000, `fix-login turns Done in 22 hours and a second, not ${waiting()[0].ms} ms`);
before = orderStore.getState().pinnedWorkspaceOrder;
Date.now = () => t0 + 22 * HOUR + 1000;
waiting()[0].callback();
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(statusGroups(statusLayout()).slice(-2), [["idle", "Idle", ["recent"]], ["done", DONE, ["fix-login", "old-docs", "never"]]]);
assert.equal(waiting().length, 1, "one timer, for recent");
Date.now = realNow;
// Grouped by project there is no Idle, and no timer.
layout({ hosts: [BOX] });
assert.deepEqual(waiting(), []);

// "Mark as done" in the command palette, offered by every copy on its own host's workspaces, sends
// a workspace in Idle to Done. It is saved on that host only, which drops marks a day old.
const removeMarkAsDone = new Map([mini, box].map((host) => [host, addMarkAsDone(host.client)]));
const [markAsDone] = box.commands;
assert.equal(markAsDone.title, "Mark as done");
assert.equal(markAsDone.context, "workspace");
const select = (id, status, hoursAgo) =>
  markAsDone.onSelect({
    context: "workspace",
    workspace: { id, status, statusEnteredAt: hoursAgo === null ? null : new Date(t0 - hoursAgo * HOUR).toISOString() },
  });
box.save({ done: { "gone-workspace": t0 - 25 * HOUR } });
const miniWrites = mini.writes;
before = orderStore.getState().pinnedWorkspaceOrder;
await select("fix-login", "done", 2);
assert.deepEqual(box.stored.done, { "fix-login": t0 - 2 * HOUR });
assert.equal(mini.writes, miniWrites);
assert.ok(readDone().size === 1);
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(statusGroups(statusLayout()).slice(-2), [["idle", "Idle", ["recent"]], ["done", DONE, ["fix-login", "old-docs", "never"]]]);
// The shortcuts follow the groups, though Done is no longer newest first across Idle and Done.
assert.deepEqual(shortcuts(statusLayout()), ["review", "build", "recent", "fix-login", "old-docs", "never"]);
// Only a workspace in Idle is marked; Paseo shows the error in a toast.
for (const [id, status, hoursAgo] of [["fix-login", "done", 2], ["build", "running", 1], ["old-docs", "done", 30], ["never", "done", null]]) {
  await assert.rejects(async () => select(id, status, hoursAgo), /This workspace is not in Idle/);
}
// Once its status changes, the mark no longer applies: done again, it waits in Idle again.
const rerun = ROWS.map((row) => (row[0] === "fix-login" ? ["fix-login", "done", 0.1] : row));
assert.deepEqual(statusGroups(statusLayout({ rows: rerun })).slice(-2), [["idle", "Idle", ["fix-login", "recent"]], ["done", DONE, ["old-docs", "never"]]]);
// Another app marking one on that host shows here too.
box.save({ done: { ...box.stored.done, recent: t0 - 0.5 * HOUR } });
box.changed("workspaces");
await settle();
assert.deepEqual(statusGroups(statusLayout()).slice(-1), [["done", DONE, ["recent", "fix-login", "old-docs", "never"]]]);

// A workspace in Done whose agent waits on a subagent, one it started that is still working, or one
// those started, sits in Waiting above Idle with Working's icon, whichever host the subagent is on.
// Every copy follows its own host's agents, background ones included.
box.save({ done: {} });
box.changed("workspaces");
await settle();
const agentSnapshot = (id, workspaceId, status, parent, archivedAt = null) => ({
  id,
  workspaceId,
  status,
  labels: parent ? { "paseo.parent-agent-id": parent } : {},
  archivedAt,
});
const lead = agentSnapshot("lead", "fix-login", "idle");
box.agentEntries = [lead, agentSnapshot("worker", "worker-ws", "running", "lead"), agentSnapshot("writer", "old-docs", "idle")];
const leaveAgents = new Map([mini, box].map((host) => [host, joinAgents(host.client)]));
await settle();
assert.deepEqual(box.agentRequests, [{ scope: "active", includeBackground: true, page: { limit: 200 }, subscribe: {} }]);
assert.deepEqual([...readWaiting()], ["fix-login"]);
result = statusLayout();
assert.deepEqual(statusGroups(result), [
  ["attention", "sidebar.statusBucket.readyToReview", ["review"]],
  ["running", "sidebar.statusBucket.working", ["build"]],
  ["waiting", "Waiting", ["fix-login"]],
  ["idle", "Idle", ["recent"]],
  ["done", DONE, ["old-docs", "never"]],
]);
assert.deepEqual(result.workspaceGroups[2].leading, result.workspaceGroups[1].leading, "Working's icon");
assert.deepEqual(shortcuts(result), ["review", "build", "fix-login", "recent", "old-docs", "never"]);
assert.deepEqual(shortcuts(statusLayout({ collapsed: ["waiting"] })), ["review", "build", "recent", "old-docs", "never"]);
// Waiting outlasts Idle's day, and Mark as done leaves it alone.
assert.deepEqual(statusGroups(statusLayout({ rows: [["fix-login", "done", 30]] })), [["waiting", "Waiting", ["fix-login"]]]);
await assert.rejects(async () => select("fix-login", "done", 2), /This workspace is not in Idle/);
// The subagent finishing lays the sidebar out again, and the workspace moves on to Idle.
const agentUpdate = (host, payload) => host.agentObservers[0].update({ type: "agent_update", payload });
before = orderStore.getState().pinnedWorkspaceOrder;
agentUpdate(box, { kind: "upsert", agent: agentSnapshot("worker", "worker-ws", "idle", "lead") });
assert.notEqual(orderStore.getState().pinnedWorkspaceOrder, before);
assert.deepEqual(statusGroups(statusLayout()).slice(2), [["idle", "Idle", ["recent", "fix-login"]], ["done", DONE, ["old-docs", "never"]]]);
// The subagent's own subagent, on another host, keeps it waiting; other agent updates change nothing.
agentUpdate(mini, { kind: "upsert", agent: agentSnapshot("tester", "tester-ws", "initializing", "worker") });
assert.deepEqual([...readWaiting()].sort(), ["fix-login", "worker-ws"]);
before = orderStore.getState().pinnedWorkspaceOrder;
agentUpdate(box, { kind: "upsert", agent: agentSnapshot("writer", "old-docs", "idle") });
agentUpdate(mini, { kind: "upsert", agent: agentSnapshot("tester", "tester-ws", "running", "worker") });
assert.equal(orderStore.getState().pinnedWorkspaceOrder, before, "no relayout while the waiting workspaces stay the same");
// An agent that is working itself is not waiting; nor is one whose subagent is gone or archived.
agentUpdate(box, { kind: "upsert", agent: agentSnapshot("lead", "fix-login", "running") });
assert.deepEqual([...readWaiting()], ["worker-ws"]);
agentUpdate(box, { kind: "upsert", agent: lead });
agentUpdate(mini, { kind: "remove", agentId: "tester" });
assert.deepEqual([...readWaiting()], []);
agentUpdate(box, { kind: "upsert", agent: agentSnapshot("worker", "worker-ws", "running", "lead", "2026-10-23T12:00:00Z") });
assert.deepEqual([...readWaiting()], []);
// A reconnect brings the host's agents again.
box.agentObservers[0].snapshot({ subscriptionId: "agents", entries: [{ agent: lead }, { agent: agentSnapshot("worker", "worker-ws", "running", "lead") }] });
assert.deepEqual([...readWaiting()], ["fix-login"]);
// Agents that name each other are not waiting on anything.
assert.deepEqual(
  [...waitingWorkspaces(new Map([["a", { workspaceId: "wa", parentId: "b", working: false }], ["b", { workspaceId: "wb", parentId: "a", working: false }]]))],
  [],
);
// A copy that stops takes its host's agents with it, and releases the daemon's subscription, also
// when it stops before the list arrives. An app without the agent list only warns.
leaveAgents.get(box)();
assert.ok(box.agentsReleased);
assert.deepEqual([...readWaiting()], []);
leaveAgents.get(mini)();
const late = fakeHost("late");
joinAgents(late.client)();
await settle();
assert.ok(late.agentsReleased);
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
joinAgents({ paseo: {} })();
await settle();
console.warn = warn;
assert.match(warnings.join("\n"), /cannot follow this host's agents/);

for (const remove of removeMarkAsDone.values()) remove();
assert.deepEqual(box.commands, []);

// A second host's copy wraps nothing new, and the patch stays until every copy unloads.
await setHidden("pasode", true);
unpatch();
unpatch();
assert.deepEqual(names(layout({ hosts: [BOX] })), ["coding", "ragokan", "warp"]);
// The last copy to unload stops the timer.
statusLayout({ rows: [["fresh", "done", 0.5]] });
const [timer] = waiting();
unpatchSecondHost();
assert.equal(projection.buildSidebarProjection, original);
assert.ok(timer.cleared);
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
assert.deepEqual(names(layout({ hosts: [BOX] })), ["coding", "pasode", "ragokan", "warp"]);
assert.deepEqual(names(layout({ hosts: [BOX], extra: numbered })).slice(-2), ["3608-overlays-close-on-settings", "0-scratch"], "Paseo itself shows them");

// With no host left, nothing is hidden.
for (const stop of leave.values()) stop();
assert.deepEqual(hidden(), []);

// The tweaks. Paseo's selectMetaRowItems runs here as it is; HostBadge and the New workspace form
// need the app's theme and page, so stand-ins shaped like them take their place.
const React = require("react");
const { applyTweaks } = loadPlugin("client/tweaks.ts");
const { metroModules } = loadPlugin("client/sidebar.ts");
const metaRow = metroRequire(idOf(".selectMetaRowItems=function"));
const selectMetaRowItems = metaRow.selectMetaRowItems;
const rowInput = (visible = {}) => ({
  currentBranch: "main",
  projectName: "ragokan",
  hasHostBadge: true,
  prHint: null,
  serviceSummary: null,
  labels: [{ name: "Idle", color: "amber" }],
  visible: { branch: false, project: true, changeRequest: true, services: true, labels: true, ...visible },
  checksDisplay: "none",
});
const kinds = (input) => metaRow.selectMetaRowItems(input).map((item) => item.kind);
assert.deepEqual(kinds(rowInput()), ["project", "host", "labels"], "Paseo puts the folder before the machine");

const icon = React.createElement("ServerIcon", { size: 12 });
const badgeStyle = { flexDirection: "row" };
const badgeModule = {
  HOST_BADGE_ICON_SIZE: 12,
  HostBadge: ({ badge }) =>
    React.createElement("View", {
      style: badgeStyle,
      testID: `host-badge-${badge.serverId}`,
      children: [icon, badge.showLabel ? React.createElement("Text", { children: badge.label }) : null],
    }),
};
const field = (testID) => React.createElement("FieldTrigger", { testID });
const control = (child) => React.createElement("View", { children: child });
const dot = React.createElement("HostStatusDot", { serverId: BOX });
const hostPicker = React.createElement("HostPicker", { children: React.createElement("FieldTrigger", { testID: "host-picker-trigger", icon: dot, value: "ragdevbox" }) });
const forms = {
  desktop: React.createElement("View", { children: [control(field("new-workspace-project-picker-trigger")), control(hostPicker), control(field("isolation"))] }),
  compact: React.createElement("View", { children: [field("new-workspace-project-picker-trigger"), hostPicker, field("isolation")] }),
  other: React.createElement("View", { children: [field("isolation"), field("new-workspace-project-picker-trigger")] }),
};
const formModule = { useNewWorkspaceForm: (layout) => forms[layout] };
const loaded = (exports) => ({ isInitialized: true, publicModule: { exports } });
const store = { hosts: [{ serverId: BOX }], emitted: 0, emitHostList() { this.emitted += 1; } };
globalThis.__paseoHostRuntimeStore = store;

// The New workspace screen's module loads later than the rest: it is looked for again.
const registry = new Map([...metroModules(), ["badge", loaded(badgeModule)]]);
const looks = [];
globalThis.setTimeout = (callback, ms) => (looks.push({ callback, ms }), looks.length);
const hostsBefore = store.hosts;
const untweak = applyTweaks(registry);
const untweakSecondHost = applyTweaks(registry);
assert.deepEqual(kinds(rowInput()), ["host", "project", "labels"], "the machine before the folder");
assert.deepEqual(kinds(rowInput({ branch: true })), ["host", "branch", "project", "labels"]);
assert.deepEqual(kinds({ ...rowInput(), hasHostBadge: false }), ["project", "labels"]);
assert.ok(store.emitted >= 1 && store.hosts !== hostsBefore && store.hosts[0] === hostsBefore[0], "the rows draw again");
const named = badgeModule.HostBadge({ badge: { serverId: BOX, label: "ragdevbox", showLabel: true } });
assert.equal(named.props.testID, `host-badge-${BOX}`);
assert.equal(React.Children.toArray(named.props.children).length, 1, "the name without the server icon");
assert.equal(React.Children.toArray(named.props.children)[0].props.children, "ragdevbox");
assert.deepEqual(named.props.style, [badgeStyle, { opacity: 0.75 }], "a quarter fainter");
const iconOnly = badgeModule.HostBadge({ badge: { serverId: BOX, label: "ragdevbox", showLabel: false } });
assert.equal(iconOnly.props.children[0], icon, "a badge showing no name keeps its icon");
assert.equal(iconOnly.props.style, badgeStyle, "and its strength");
assert.equal(formModule.useNewWorkspaceForm("desktop"), forms.desktop, "not loaded yet");
assert.equal(looks.length, 2);
registry.set("form", loaded(formModule));
looks.shift().callback();
const fields = (form) => React.Children.toArray(form.props.children).map((child) => JSON.stringify(child.props).match(/"testID":"([^"]+)"/)[1]);
assert.deepEqual(fields(formModule.useNewWorkspaceForm("desktop")), ["host-picker-trigger", "new-workspace-project-picker-trigger", "isolation"]);
assert.deepEqual(fields(formModule.useNewWorkspaceForm("compact")), ["host-picker-trigger", "new-workspace-project-picker-trigger", "isolation"]);
// The host's status dot goes in a marker the desktop and web page hides, the trigger otherwise as it was.
for (const layout of ["desktop", "compact"]) {
  const [host] = React.Children.toArray(formModule.useNewWorkspaceForm(layout).props.children);
  const picker = layout === "desktop" ? React.Children.only(host.props.children) : host;
  const trigger = React.Children.only(picker.props.children);
  assert.equal(trigger.props.testID, "host-picker-trigger");
  assert.equal(trigger.props.value, "ragdevbox");
  assert.equal(trigger.props.icon.props.testID, "tweaks-host-status");
  assert.equal(React.Children.only(trigger.props.icon.props.children), dot);
}
assert.equal(formModule.useNewWorkspaceForm("other"), forms.other, "fields it does not know stay put");
looks.shift().callback();
assert.equal(looks.length, 0, "all found, no more looking");
// The last copy to unload puts Paseo's own back.
untweak();
assert.deepEqual(kinds(rowInput()), ["host", "project", "labels"]);
untweakSecondHost();
assert.equal(metaRow.selectMetaRowItems, selectMetaRowItems);
assert.equal(badgeModule.HostBadge({ badge: { serverId: BOX, label: "ragdevbox", showLabel: true } }).props.children.length, 2);
assert.equal(formModule.useNewWorkspaceForm("desktop"), forms.desktop);
globalThis.setTimeout = realSetTimeout;
delete globalThis.__paseoHostRuntimeStore;
console.log(`ok: sidebar layout, order store, hiding, Waiting and Idle, and the tweaks in ${bundlePath}`);
