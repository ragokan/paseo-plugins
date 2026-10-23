// Copies every other plugin in this repository into this one, because Paseo compiles a plugin only
// from files inside its own folder. Paseo runs this on install and update ("build" in
// paseo-plugin.json); run it yourself before a typecheck or a local directory install:
//   node build.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(root);
const RUNTIMES = ["client", "server", "shared"];
const CODE = /\.[cm]?[jt]sx?$/;
// Relative specifiers in `from "…"`, `import "…"` and `import("…")`.
const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']*)\2/g;

// Where a plugin file lands here: <name>/index.client.tsx becomes client/plugins/<name>/index.tsx,
// <name>/shared/rpc.ts becomes shared/plugins/<name>/rpc.ts. Anything else is not plugin code.
function destination(name, file) {
  const entry = /^index\.(client|server)(\.tsx?)$/.exec(file);
  if (entry) return path.join(root, entry[1], "plugins", name, `index${entry[2]}`);
  const [runtime, ...rest] = file.split("/");
  if (!RUNTIMES.includes(runtime) || rest.length === 0) return null;
  return path.join(root, runtime, "plugins", name, ...rest);
}

function rewriteImports(name, file, source) {
  const from = path.dirname(destination(name, file));
  return source.replace(RELATIVE_IMPORT, (match, prefix, quote, specifier) => {
    const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const target = destination(name, imported);
    if (!target) throw new Error(`${name}/${file} imports ${specifier}, outside client/, server/ and shared/`);
    const relative = path.relative(from, target).split(path.sep).join("/");
    return `${prefix}${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`;
  });
}

function pluginFiles(directory, prefix = "") {
  return readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : pluginFiles(directory, file);
    return /\.test\./.test(entry.name) ? [] : [file];
  });
}

for (const runtime of RUNTIMES) rmSync(path.join(root, runtime, "plugins"), { recursive: true, force: true });

const copied = [];
for (const entry of readdirSync(repository, { withFileTypes: true })) {
  const directory = path.join(repository, entry.name);
  if (!entry.isDirectory() || directory === root || !existsSync(path.join(directory, "paseo-plugin.json"))) continue;
  for (const file of pluginFiles(directory)) {
    const target = destination(entry.name, file);
    if (!target) continue;
    if (existsSync(target)) throw new Error(`${entry.name}/${file} and another file both land on ${target}`);
    mkdirSync(path.dirname(target), { recursive: true });
    if (CODE.test(file)) writeFileSync(target, rewriteImports(entry.name, file, readFileSync(path.join(directory, file), "utf8")));
    else copyFileSync(path.join(directory, file), target);
  }
  copied.push(entry.name);
}
console.log(`Copied ${copied.join(", ")}`);
