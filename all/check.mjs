// Checks the build's copy of the other plugins, the client switches and the server gate:
//   npm run check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function load(file) {
  const { outputText } = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(require, module, module.exports);
  return module.exports;
}

// The build copies every plugin, and every relative import still points at a file in this plugin.
execFileSync(process.execPath, [path.join(root, "build.mjs")], { stdio: "inherit" });
const { FEATURES, DEFAULT_FEATURES } = load("shared/features.ts");
const features = FEATURES.map((feature) => feature.id);
assert.equal(DEFAULT_FEATURES["machine-status"], false, "machine-status starts off");
assert.equal(DEFAULT_FEATURES.themes, true, "the rest start on");
for (const id of features) {
  assert.ok(["index.ts", "index.tsx"].some((file) => existsSync(path.join(root, "client/plugins", id, file))), `${id} client entry copied`);
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

console.log(`ok: ${features.length} features copied, ${imports} relative imports resolved, switches and gate behave`);
