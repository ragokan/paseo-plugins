// Checks the app internals the plugin borrows against the installed Paseo app bundle, runs the app's
// own clearWorkspaceAttention, then runs the plugin against fake hosts. Re-run after Paseo updates:
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

// Minimal Metro runtime over the bundle's own module lines, so the check runs Paseo's real code.
// A module starts a line with `__d(` and may span lines (template literals).
const lines = new Map();
let current;
for (const line of bundle.split("\n")) {
  if (line.startsWith("__d(")) current = line;
  else if (current !== undefined) current += `\n${line}`;
  const match = current !== undefined && /\},(\d+),\[([\d,]*)\]\);$/.exec(current);
  if (match) lines.set(Number(match[1]), current), (current = undefined);
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
const findModule = (needle) => {
  const found = [...lines].filter(([, line]) => line.includes(needle));
  assert.equal(found.length, 1, `expected one module with ${needle}`);
  return found[0];
};

// The host runtime store keeps its singleton on globalThis.__paseoHostRuntimeStore. Loading that
// module pulls in the app's UI, so check its source.
const [, storeModule] = findModule('"HostRuntimeStore",{enumerable');
const key = /(\w+)="__paseoHostRuntimeStore"/.exec(storeModule)?.[1];
assert.ok(key, "the host runtime store's global key changed");
assert.match(storeModule, new RegExp(`Reflect\\.get\\(globalThis,${key}\\);return \\w+ instanceof \\w+`));
assert.match(storeModule, /\}getHosts\(\)\{return this\.hosts\}/);
assert.match(storeModule, /\}getSnapshot\((\w+)\)\{return this\.controllers\.get\(\1\)\?\.getSnapshot\(\)\?\?null\}/);
// The SDK's getPaseoClient reads the same snapshot fields for the same purpose.
const [, pluginHosts] = findModule("e.createPluginHosts=function");
assert.match(pluginHosts, /"online"!==\w+\?\.connectionStatus\|\|!\w+\.client/);
assert.match(pluginHosts, /getHosts\(\)\.map\(\(\{serverId:\w+,label:\w+\}\)/);

// The app's own daemon client clears several workspaces in one request, and throws when the daemon fails.
const [clientId] = findModule("async clearWorkspaceAttention(");
const daemonClient = Object.create(metroRequire(clientId).DaemonClient.prototype);
const sent = [];
daemonClient.createRequestId = () => "req-1";
let daemonReply = { success: true, error: null };
daemonClient.sendRequest = async ({ message, select }) => {
  sent.push(message);
  return select({ type: "workspace.clear_attention.response", payload: { requestId: "req-1", ...daemonReply } });
};
await daemonClient.clearWorkspaceAttention(["ws-a", "ws-b"]);
assert.deepEqual(sent, [{ type: "workspace.clear_attention.request", workspaceId: ["ws-a", "ws-b"], requestId: "req-1" }]);
daemonReply = { success: false, error: "workspace gone" };
await assert.rejects(daemonClient.clearWorkspaceAttention(["ws-a"]), /workspace gone/);

// The command palette runs global items and shows a thrown error as a toast; the icon is a Lucide name.
assert.match(bundle, /if\("global"===\w+\.context\)return void await \w+\.onSelect\(\{context:"global",\.\.\.\w+\}\)/);
assert.match(bundle, /reportError\((\w+)\)\{\w+\.error\(\1 instanceof Error\?\1\.message:String\(\1\)\)\}/);
assert.match(bundle, /defineProperty\(\w+,"CheckCheck",\{enumerable/);

// The plugin against fake hosts.
const { outputText } = ts.transpileModule(readFileSync(new URL("index.client.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const listCalls = [];
const pages = new Map();
const plugin = { exports: {} };
new Function("require", "module", "exports", outputText)(
  (id) => {
    assert.equal(id, "@getpaseo/plugin/client");
    return {
      getPaseoClient: (serverId) => ({
        agents: {
          async list(options) {
            listCalls.push({ serverId, ...options });
            const result = pages.get(serverId)?.[options.page.cursor ?? "first"];
            if (result instanceof Error) throw result;
            return result;
          },
        },
      }),
    };
  },
  plugin,
  plugin.exports,
);
const { default: contribute, findHostRuntimeStore, markAllRead } = plugin.exports;

const agent = (workspaceId, extra = {}) => ({ agent: { workspaceId, archivedAt: null, pendingPermissions: [], attentionReason: "finished", ...extra } });
pages.set("srv_a", {
  first: {
    entries: [
      agent("ws1"),
      agent("ws2", { attentionReason: "error" }),
      agent("ws3", { attentionReason: "permission" }),
      agent("ws4", { pendingPermissions: [{ id: "p" }] }),
    ],
    pageInfo: { hasMore: true, nextCursor: "next" },
  },
  next: {
    entries: [agent("ws1"), agent("ws5", { archivedAt: "2026-10-01T00:00:00Z" }), agent(undefined)],
    pageInfo: { hasMore: false, nextCursor: null },
  },
});
pages.set("srv_b", { first: { entries: [], pageInfo: { hasMore: false, nextCursor: null } } });
pages.set("srv_d", { first: new Error("list failed") });

const cleared = [];
const client = (serverId) => ({ clearWorkspaceAttention: async (ids) => void cleared.push({ serverId, ids }) });
const hosts = [
  { serverId: "srv_a", label: "ragmini", status: "online" },
  { serverId: "srv_b", label: "ragdevbox", status: "online" },
  { serverId: "srv_c", label: " ", status: "offline" },
  { serverId: "srv_d", label: "ragair", status: "online" },
];
const store = {
  getHosts: () => hosts.map(({ serverId, label }) => ({ serverId, label })),
  getSnapshot: (serverId) => {
    const { status } = hosts.find((host) => host.serverId === serverId);
    return { connectionStatus: status, client: status === "online" ? client(serverId) : null };
  },
};

// Every host is tried; the toast names the ones that failed, by label or server ID.
await assert.rejects(markAllRead(store), {
  message: "Mark All as Read failed on srv_c (offline), ragair (list failed)",
});
// Unread and failed agents' workspaces, once each; agents waiting on a permission, archived or
// without a workspace are left alone; a host with nothing unread gets no request.
assert.deepEqual(cleared, [{ serverId: "srv_a", ids: ["ws1", "ws2"] }]);
const query = { includeBackground: true, filter: { requiresAttention: true } };
assert.deepEqual(
  listCalls.map(({ serverId, page, ...rest }) => (assert.deepEqual(rest, query), [serverId, page])),
  [
    ["srv_a", { limit: 200, cursor: undefined }],
    ["srv_b", { limit: 200, cursor: undefined }],
    ["srv_d", { limit: 200, cursor: undefined }],
    ["srv_a", { limit: 200, cursor: "next" }],
  ],
);

// A clear that fails on one host is reported too.
cleared.length = 0;
hosts[2].status = "online";
pages.set("srv_c", pages.get("srv_b"));
pages.delete("srv_d");
pages.set("srv_d", pages.get("srv_a"));
store.getSnapshot = (serverId) => ({
  connectionStatus: "online",
  client: serverId === "srv_d" ? { clearWorkspaceAttention: () => Promise.reject(new Error("daemon said no")) } : client(serverId),
});
await assert.rejects(markAllRead(store), { message: "Mark All as Read failed on ragair (daemon said no)" });
assert.deepEqual(cleared, [{ serverId: "srv_a", ids: ["ws1", "ws2"] }]);

// Without the app's store the command fails with a message instead of doing nothing.
delete globalThis.__paseoHostRuntimeStore;
assert.throws(findHostRuntimeStore, /Paseo host runtime not found/);

// The palette item is global and runs against the app's store.
let item;
const cleanup = () => {};
assert.equal(contribute({ addCommandCenterItem: (contribution) => ((item = contribution), cleanup) }), cleanup);
assert.deepEqual(
  { id: item.id, title: item.title, icon: item.icon, context: item.context },
  { id: "mark-all-read", title: "Mark All as Read", icon: "CheckCheck", context: "global" },
);
await assert.rejects(item.onSelect(), /Paseo host runtime not found/);
globalThis.__paseoHostRuntimeStore = { ...store, getHosts: () => [{ serverId: "srv_a", label: "ragmini" }] };
cleared.length = 0;
await item.onSelect();
assert.deepEqual(cleared, [{ serverId: "srv_a", ids: ["ws1", "ws2"] }]);

console.log(`ok: host runtime store, daemon client module ${clientId} and command palette in ${bundlePath}`);
