// Runs the plugin against the installed Paseo app bundle: finds the grouping module, then merges
// real buildWorkspaceStructureProjects output. Re-run after Paseo updates:
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
new Function("require", "module", "exports", outputText)(() => ({}), plugin, plugin.exports);
const { findStructureModule, patch } = plugin.exports;

// Minimal Metro runtime over the bundle's own module lines, so the test runs Paseo's real code.
const lines = new Map();
for (const line of bundle.split("\n")) {
  const match = line.startsWith("__d(") && /\},(\d+),\[([\d,]*)\]\);$/.exec(line);
  if (match) lines.set(Number(match[1]), line);
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

async function lookup(source) {
  let requestedId;
  globalThis.document = { scripts: [{ src: "app://other.js" }, { src: "app:///_expo/static/js/web/index.js" }] };
  globalThis.fetch = async () => ({ text: async () => source });
  globalThis.__r = (id) => ((requestedId = id), metroRequire(id));
  return { module: await findStructureModule(), requestedId };
}

const { module, requestedId } = await lookup(bundle);
assert.match(lines.get(requestedId), /\.buildWorkspaceStructureProjects=function/);
await assert.rejects(lookup("__d(function(){},1,[]);"), /project grouping not found/);

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

const original = module.buildWorkspaceStructureProjects;
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
console.log(`ok: grouping is module ${requestedId} in ${bundlePath}; merged ${before.length} projects into ${after.length}`);
