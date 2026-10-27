// Checks the build's copy of the other plugins, the client switches and the server gate:
//   npm run check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The app skips a plugin its version doesn't meet; 0.13.0 is the oldest Paseo these plugins support.
const manifest = JSON.parse(readFileSync(path.join(root, "paseo-plugin.json"), "utf8"));
assertPluginCompatibility({ ...manifest, version: "0.13.0", runtime: "app" });

// Plugin modules, compiled to CommonJS; relative imports load the same way, packages from node_modules.
const modules = new Map();
function load(file) {
  if (!modules.has(file)) {
    const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    });
    const module = { exports: {} };
    modules.set(file, module);
    const localRequire = (specifier) => {
      if (!specifier.startsWith(".")) return require(specifier);
      const base = path.join(path.dirname(file), specifier);
      return load([".ts", ".tsx"].map((extension) => base + extension).find((candidate) => existsSync(path.join(root, candidate))));
    };
    new Function("require", "module", "exports", outputText)(localRequire, module, module.exports);
  }
  return modules.get(file).exports;
}

// The build copies every plugin, and every relative import still points at a file in this plugin.
execFileSync(process.execPath, [path.join(root, "build.mjs")], { stdio: "inherit" });
const { FEATURES, DEFAULT_APP_FEATURES, hostFeatureSettings } = load("shared/features.ts");
const features = FEATURES.map((feature) => feature.id);
assert.ok(Object.values(DEFAULT_APP_FEATURES).every(Boolean), "app plugins start on");
assert.deepEqual(
  hostFeatureSettings(true).schema.parse({}),
  { "mcp-toggle": true, "machine-status": true, "continue-after-error": true, "status-labels": true, "agent-titles": true, "run-it": true, "browseros-neo": false },
  "machine status on for Linux, BrowserOS Neo off",
);
assert.deepEqual(
  hostFeatureSettings(false).schema.parse({}),
  { "mcp-toggle": true, "machine-status": false, "continue-after-error": true, "status-labels": true, "agent-titles": true, "run-it": true, "browseros-neo": false },
  "and off elsewhere, BrowserOS Neo off too",
);
for (const feature of FEATURES) {
  const [runtime, entry] = feature.serverOnly ? ["server", "server entry"] : ["client", "client entry"];
  assert.ok(["index.ts", "index.tsx"].some((file) => existsSync(path.join(root, runtime, "plugins", feature.id, file))), `${feature.id} ${entry} copied`);
}
function codeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : codeFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}
let imports = 0;
for (const file of [path.join(root, "index.client.tsx"), path.join(root, "index.server.ts"), ...["client", "server", "shared"].flatMap((dir) => codeFiles(path.join(root, dir)))]) {
  for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']*)["']/g)) {
    const target = path.resolve(path.dirname(file), specifier);
    assert.ok(!path.relative(root, target).startsWith(".."), `${file} imports ${specifier} from outside the plugin`);
    assert.ok(["", ".ts", ".tsx"].some((extension) => existsSync(target + extension)), `${file} imports missing ${specifier}`);
    imports++;
  }
}

// Client: a switched-off plugin loses everything it added, even with an empty cleanup of its own.
const { createSwitches } = load("client/switches.ts");
const registered = new Set();
const client = {
  locale: "en",
  addTheme(theme) {
    if (registered.has(theme.id)) throw new Error(`Duplicate theme: ${theme.id}`);
    registered.add(theme.id);
    return () => registered.delete(theme.id);
  },
  addComposerPill(pill) {
    registered.add(pill.id);
    return { update() {}, remove: () => registered.delete(pill.id) };
  },
};
const log = [];
const switches = createSwitches(client, {
  themes(scoped) {
    assert.equal(scoped.locale, "en", "plain properties pass through");
    scoped.addTheme({ id: "monokai" });
    scoped.addComposerPill({ id: "pill" });
    log.push("themes started");
    return () => {};
  },
  patcher() {
    log.push("patcher started");
    return async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push("patcher stopped");
    };
  },
  broken() {
    throw new Error("boom");
  },
});
const warn = console.warn;
console.warn = () => {};
await switches.apply({ themes: true, patcher: true, broken: true });
console.warn = warn;
assert.deepEqual([...registered].sort(), ["monokai", "pill"]);
await switches.apply({ themes: false, patcher: false, broken: true });
assert.deepEqual([...registered], [], "theme and pill removed when switched off");
assert.ok(log.includes("patcher stopped"), "async cleanup awaited");
// Off and straight back on: the restart waits for the stop, so no duplicate registration.
void switches.apply({ themes: false, patcher: false, broken: false });
await switches.apply({ themes: true, patcher: false, broken: false });
assert.deepEqual([...registered].sort(), ["monokai", "pill"], "restarted cleanly");
await switches.dispose();
assert.deepEqual([...registered], [], "dispose stops everything");
await switches.apply({ themes: true, patcher: true, broken: false });
assert.deepEqual([...registered], [], "nothing starts after dispose");

// App plugins: copies for several hosts share one realm, and only one of them runs each app plugin.
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const { joinAppFeatures, setAppFeature, whileAppFeature } = load("client/app-features.ts");
const themesOn = new Set();
function hostCopy(host) {
  const hostClient = {
    addTheme(theme) {
      themesOn.add(`${host}/${theme.id}`);
      return () => themesOn.delete(`${host}/${theme.id}`);
    },
  };
  // Each copy brings its own bundle, so its own contributions.
  return joinAppFeatures(hostClient, { themes: (scoped) => void scoped.addTheme({ id: "monokai" }) });
}
const leaveMini = hostCopy("ragmini");
const leaveDevbox = hostCopy("ragdevbox");
await setAppFeature("themes", true);
assert.deepEqual([...themesOn], ["ragmini/monokai"], "only the first copy runs the app plugin");
await setAppFeature("themes", false);
assert.deepEqual([...themesOn], [], "the app switch stops it");
assert.equal(JSON.parse(storage.get("ragokan/paseo-plugins/all/app-features")).themes, false, "and is saved in the app");
await setAppFeature("themes", true);
await leaveMini();
assert.deepEqual([...themesOn], ["ragdevbox/monokai"], "another copy takes over when the first stops");
await leaveDevbox();
assert.deepEqual([...themesOn], [], "the last copy to stop takes it down");

// What every copy adds for itself while an app plugin is on, like the tweaks' Mark as done.
const commands = new Set();
const whileThemes = (host) => whileAppFeature("themes", () => (commands.add(host), () => commands.delete(host)));
const stopMini = whileThemes("ragmini");
const stopDevbox = whileThemes("ragdevbox");
assert.deepEqual([...commands], ["ragmini", "ragdevbox"], "every copy, while it is on");
await setAppFeature("themes", false);
assert.deepEqual([...commands], [], "the app switch takes them off");
await setAppFeature("themes", true);
assert.deepEqual([...commands], ["ragmini", "ragdevbox"], "and puts them back once");
stopMini();
await setAppFeature("themes", false);
await setAppFeature("themes", true);
assert.deepEqual([...commands], ["ragdevbox"], "a copy that stops follows the switch no more");
stopDevbox();
assert.deepEqual([...commands], []);

// Server: handlers and hooks register once and follow the switch on every call.
const { gate } = load("server/gate.ts");
const handlers = new Map();
const hooks = new Map();
const server = {
  handle: (contract, handler) => handlers.set(contract.name, handler),
  before: (name, handler) => (hooks.set(name, handler), () => hooks.delete(name)),
  registerSettings: () => "settings",
};
let on = true;
const gated = gate(server, "mcp-toggle", () => on);
gated.handle({ name: "mcp-toggle.list" }, (input) => `listed ${input}`);
const stopHook = gated.before("agent.session_open", ({ request }) => ({ ...request, touched: true }));
assert.equal(gated.registerSettings(), "settings", "other methods pass through");
assert.equal(await handlers.get("mcp-toggle.list")("x"), "listed x");
assert.deepEqual(await hooks.get("agent.session_open")({ request: { cwd: "/a" } }), { cwd: "/a", touched: true });
on = false;
assert.throws(() => handlers.get("mcp-toggle.list")("x"), /switched off/);
assert.equal(await hooks.get("agent.session_open")({ request: { cwd: "/a" } }), undefined, "hook leaves the request alone");
stopHook();
assert.equal(hooks.size, 0, "hook remover passes through");

console.log(`ok: ${features.length} features copied, ${imports} relative imports resolved, switches, sharing, per-copy app plugins and gate behave`);
