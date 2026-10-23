// Runs the plugin against the installed Paseo app bundle: finds the grouping module through the
// bundle's own Metro runtime, then merges real buildWorkspaceStructureProjects output. Re-run after
// Paseo updates:
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

const { outputText } = ts.transpileModule(readFileSync(new URL("index.client.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const plugin = { exports: {} };
// Loaded as on iOS, where the plugin used to do nothing.
const require = (name) => (name === "react-native" ? { Platform: { OS: "ios" } } : {});
new Function("require", "module", "exports", outputText)(require, plugin, plugin.exports);
const { default: contribute, findStructureModule, patch } = plugin.exports;

assert.throws(findStructureModule, /Metro runtime not found/);

// The bundle's own Metro runtime (the same one the iOS and Android builds use), with an ErrorUtils
// like React Native's, whose fatal report crashes a release build.
const lines = bundle.split("\n");
const mapGet = Map.prototype.get;
const fatal = [];
globalThis.ErrorUtils = { reportFatalError: (error) => fatal.push(error) };
globalThis.__METRO_GLOBAL_PREFIX__ = "";
(0, eval)(lines.find((line) => line.includes("Requiring unknown module")));
const metroDefine = globalThis.__d;

// Defines the grouping module, everything it imports, and some other app modules, counting which
// module factories run.
const moduleLines = new Map();
for (const line of lines) {
  const match = line.startsWith("__d(") && /\},(\d+),\[([\d,]*)\]\);$/.exec(line);
  if (match) moduleLines.set(Number(match[1]), { line, deps: match[2] ? match[2].split(",").map(Number) : [] });
}
const structureId = [...moduleLines].find(([, { line }]) => line.includes(".buildWorkspaceStructureProjects=function"))[0];
const ran = new Set();
const defined = new Set();
globalThis.__d = (factory, id, deps) =>
  metroDefine(function (...args) {
    ran.add(id);
    return factory.apply(this, args);
  }, id, deps);
const define = (id, { withImports = false } = {}) => {
  if (defined.has(id)) return;
  defined.add(id);
  (0, eval)(moduleLines.get(id).line);
  if (withImports) moduleLines.get(id).deps.forEach((dep) => define(dep, { withImports }));
};
define(structureId, { withImports: true });
const others = [...moduleLines.keys()].filter((id) => !defined.has(id)).slice(0, 200);
others.forEach((id) => define(id));

// Not loaded yet: the lookup finds nothing and loads nothing.
assert.throws(findStructureModule, /project grouping not found/);
assert.equal(ran.size, 0);

// Not loaded when the plugin starts: it looks again until the app has loaded the module.
const timers = [];
globalThis.setTimeout = (callback) => timers.push(callback);
globalThis.clearTimeout = () => {};
const stopEarly = contribute({});
assert.equal(timers.length, 1);
const structure = globalThis.__r(structureId);
const original = structure.buildWorkspaceStructureProjects;
const ranByApp = new Set(ran);
timers.shift()();
assert.equal(timers.length, 0);
assert.equal(typeof structure.buildWorkspaceStructureProjects.original, "function");
stopEarly();
assert.equal(structure.buildWorkspaceStructureProjects, original);

const module = findStructureModule();
assert.equal(module, structure);
assert.deepEqual(ran, ranByApp, "the lookup ran no module code");
assert.ok(others.every((id) => !ran.has(id)));
assert.deepEqual(fatal, []);
assert.equal(Map.prototype.get, mapGet);

// The user's hosts as of 22/10/2026, plus a same-host name clash and a git remote on two hosts.
const AIR = "srv_air", MINI = "srv_mini", BOX = "srv_box";
const project = (id, rootPath, projectKey, kind = "non_git") => ({
  projectId: id,
  projectKey,
  projectRootPath: rootPath,
  projectKind: kind,
  projectDisplayName: rootPath.split("/").pop(),
  projectCustomName: null,
});
const workspace = (id, projectId) => ({ id, name: id, projectId });
const PASODE = "remote:github.com/ragokan/pasode";
const sessions = [
  {
    serverId: AIR,
    projects: [project("a1", "/Users/ragokan", `host:${AIR}:/Users/ragokan`), project("a2", "/Users/ragokan/coding", `host:${AIR}:/Users/ragokan/coding`), project("a3", "/Users/ragokan/coding/pasode", PASODE, "git")],
    workspaces: [workspace("wa1", "a1"), workspace("wa3", "a3")],
  },
  {
    serverId: MINI,
    projects: [project("m1", "/Users/ragokan", `host:${MINI}:/Users/ragokan`), project("m2", "/Users", `host:${MINI}:/Users`)],
    workspaces: [workspace("wm1", "m1"), workspace("wm2", "m2")],
  },
  {
    serverId: BOX,
    projects: [
      project("b1", "/home/ragokan", `host:${BOX}:/home/ragokan`),
      project("b2", "/home/ragokan/coding", `host:${BOX}:/home/ragokan/coding`),
      project("b3", "/home/ragokan/coding/pasode", PASODE, "git"),
      project("b4", "/home/ragokan/coding/warp", "remote:github.com/warpdotdev/warp", "git"),
      project("b5", "/home/ragokan/old/warp", `host:${BOX}:/home/ragokan/old/warp`),
    ],
    workspaces: [workspace("wb2", "b2"), workspace("wb3", "b3"), workspace("wb4", "b4")],
  },
];

const before = original({ sessions });
assert.equal(before.filter((p) => p.projectName === "ragokan").length, 3);

const unpatch = patch(module);
const unpatchSecondHost = patch(module);
const after = module.buildWorkspaceStructureProjects({ sessions });
const byName = (name) => after.filter((p) => p.projectName === name);
const hostsOf = (p) => p.hosts.map((host) => host.serverId).sort();

const [home] = byName("ragokan");
assert.equal(byName("ragokan").length, 1);
assert.equal(home.viewKey, "merged:ragokan");
assert.equal(home.projectKey, null);
assert.deepEqual(hostsOf(home), [AIR, BOX, MINI].sort());
assert.deepEqual([...home.workspaceKeys].sort(), [`${AIR}:wa1`, `${MINI}:wm1`]);

assert.equal(byName("coding").length, 1);
assert.deepEqual(hostsOf(byName("coding")[0]), [AIR, BOX].sort());
assert.deepEqual(byName("coding")[0].workspaceKeys, [`${BOX}:wb2`]);

// Paseo already merged pasode by remote; it keeps its key and view key.
assert.deepEqual(byName("pasode").map((p) => [p.viewKey, p.projectKey]), [[PASODE, PASODE]]);
// Two "warp" folders on one host stay separate.
assert.equal(byName("warp").length, 2);
assert.deepEqual(after.map((p) => p.projectName), ["coding", "pasode", "ragokan", "Users", "warp", "warp"]);

// A second host's copy wraps nothing new, and the merge stays until every copy unloads.
assert.equal(module.buildWorkspaceStructureProjects({ sessions }).length, after.length);
unpatch();
unpatch();
assert.equal(module.buildWorkspaceStructureProjects({ sessions }).length, after.length);
unpatchSecondHost();
assert.equal(module.buildWorkspaceStructureProjects, original);
console.log(`ok: grouping is module ${structureId} in ${bundlePath}; merged ${before.length} projects into ${after.length}`);
