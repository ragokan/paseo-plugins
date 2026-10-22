// Runs the store lookup against the installed Paseo app bundle. Re-run after Paseo updates:
//   npm run check [path/to/index-<hash>.js]
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
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

const { outputText } = ts.transpileModule(readFileSync(new URL("index.client.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
});
const require = createRequire(import.meta.url);
const plugin = { exports: {} };
new Function("require", "module", "exports", outputText)(
  (id) => (id === "react" || id === "react/jsx-runtime" ? require(id) : id === "react-native" ? { StyleSheet: { create: (s) => s } } : {}),
  plugin,
  plugin.exports,
);

// Like the real zustand store: a hook function carrying getState/subscribe.
const fakeStore = Object.assign(() => {}, {
  getState: () => ({ hostFilters: [] }),
  setState() {},
});
async function lookup(source) {
  let requestedId;
  globalThis.document = { scripts: [{ src: "app://other.js" }, { src: "app:///_expo/static/js/web/index.js" }] };
  globalThis.fetch = async () => ({ text: async () => source });
  globalThis.__r = (id) => ((requestedId = id), { useSidebarViewStore: fakeStore });
  const store = await plugin.exports.findSidebarViewStore();
  return { store, requestedId };
}

const { store, requestedId } = await lookup(bundle);
assert.equal(store, fakeStore);
const moduleLine = bundle.split("\n").find((line) => line.startsWith("__d(") && line.includes(`},${requestedId},[`));
assert.ok(moduleLine?.includes('"useSidebarViewStore",{enumerable'), `module ${requestedId} is not the sidebar view store`);
await assert.rejects(lookup("__d(function(){},1,[]);"), /host filter not found/);
console.log(`ok: sidebar view store is module ${requestedId} in ${bundlePath}`);
