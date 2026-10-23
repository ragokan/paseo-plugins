// Runs the plugin against the installed Paseo app bundle: finds the grouping and i18next modules
// through the bundle's own Metro runtime, then groups and labels a real-shaped timeline through
// Paseo's own code. Re-run after Paseo updates:
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
// Each call evaluates a fresh copy of the plugin, as when Paseo reloads it. Loaded as on iOS, where
// the plugin used to do nothing.
const require = (name) => (name === "react-native" ? { Platform: { OS: "ios" } } : {});
function loadPlugin() {
  const plugin = { exports: {} };
  new Function("require", "module", "exports", outputText)(require, plugin, plugin.exports);
  return plugin.exports;
}
const { default: contribute, findModules, patch } = loadPlugin();

assert.throws(findModules, /Metro runtime not found/);

// The bundle's own Metro runtime (the same one the iOS and Android builds use), with an ErrorUtils
// like React Native's, whose fatal report crashes a release build.
const mapGet = Map.prototype.get;
const fatal = [];
globalThis.ErrorUtils = { reportFatalError: (error) => fatal.push(error) };
globalThis.__METRO_GLOBAL_PREFIX__ = "";
(0, eval)(bundle.split("\n").find((line) => line.includes("Requiring unknown module")));
const metroDefine = globalThis.__d;

// Each module's source and imports. A module starts a line with `__d(` and may span lines
// (template literals).
const lines = new Map();
const imports = new Map();
let current;
for (const line of bundle.split("\n")) {
  if (line.startsWith("__d(")) current = line;
  else if (current !== undefined) current += `\n${line}`;
  const match = current !== undefined && /\},(\d+),\[([\d,]*)\]\);$/.exec(current);
  if (!match) continue;
  lines.set(Number(match[1]), current);
  imports.set(Number(match[1]), match[2] ? match[2].split(",").map(Number) : []);
  current = undefined;
}
const moduleWith = (needle) => [...lines].find(([, source]) => source.includes(needle))[0];

// Defines the modules the timeline needs and everything they import, counting which module
// factories run.
const ran = new Set();
globalThis.__d = (factory, id, deps) =>
  metroDefine(function (...args) {
    ran.add(id);
    return factory.apply(this, args);
  }, id, deps);
const defined = new Set();
function define(id) {
  if (defined.has(id)) return;
  defined.add(id);
  (0, eval)(lines.get(id));
  imports.get(id).forEach(define);
}
const i18nId = moduleWith(".initReactI18next).init(");
const presentationId = moduleWith("e.createStreamPresentation=function");
const transformerId = moduleWith("e.transformTimelineItem=function");
[i18nId, presentationId, transformerId].forEach(define);

// Nothing loaded yet: the lookup finds nothing and runs no module code.
assert.throws(findModules, /tool call grouping not found/);
assert.equal(ran.size, 0);

// The app has started but opened no chat, as on a phone showing the agent list: i18next has loaded
// and the grouping module hasn't, so the plugin waits for the first thought the app transforms.
globalThis.__r(i18nId);
const transformers = [];
const client = {
  addTimelineTransformer(transformer) {
    transformers.push(transformer);
    return () => transformers.includes(transformer) && transformers.splice(transformers.indexOf(transformer), 1);
  },
};
const timers = [];
const { setTimeout } = globalThis;
globalThis.setTimeout = (callback) => timers.push(callback);
const stop = contribute(client);
assert.equal(transformers.length, 1);
assert.equal(transformers[0].query.itemType, "reasoning");

// The first chat opens: the app loads its timeline code and draws it through Paseo's own
// presentation, passing items to the plugin transformers the way the app's registry does.
const { transformTimelineItem } = globalThis.__r(transformerId);
const present = globalThis.__r(presentationId).createStreamPresentation();
const transform = (input) => transformTimelineItem({ ...input, plugins: [{ id: "merge-thinking", timelineTransformers: transformers }] });
const firstChat = { tail: [], head: [], transform, level: "overview", isTurnActive: true };
let k = 0;
const at = new Date(0);
firstChat.tail = [
  { kind: "user_message", id: `first${k++}`, text: "go", timestamp: at },
  { kind: "thought", id: `first${k++}`, text: "a", status: "ready", timestamp: at },
  { kind: "thought", id: `first${k++}`, text: "b", status: "ready", timestamp: at },
  { kind: "assistant_message", id: `first${k++}`, text: "done", timestamp: at },
];
const firstRender = present(firstChat);
// That chat merges in its first render, and the transformer changed nothing and goes after it.
assert.deepEqual(firstRender.tail.map((item) => (firstRender.groupsByHostId.has(item.id) ? "group" : item.kind)), ["user_message", "group", "assistant_message"]);
assert.deepEqual(firstRender.groupsByHostId.get(firstChat.tail[1].id).run.calls.map((call) => call.id), [firstChat.tail[1].id, firstChat.tail[2].id]);
assert.equal(transformers.length, 1);
timers.splice(0).forEach((callback) => callback());
assert.equal(transformers.length, 0);
globalThis.setTimeout = setTimeout;

const { grouping: module, i18n } = findModules();
assert.equal(module.mergeThinking?.copies.length, 1);
assert.ok(i18n, "Paseo's i18next instance not found");
assert.equal(typeof i18n.getFixedT, "function");
assert.deepEqual(fatal, []);
assert.equal(Map.prototype.get, mapGet);
// The plugin unloads; a copy that found the modules at once never adds a transformer.
stop();
assert.equal(module.mergeThinking, undefined);
const stopLoaded = contribute(client);
assert.equal(transformers.length, 0);
assert.equal(module.mergeThinking?.copies.length, 1);
stopLoaded();
assert.equal(module.mergeThinking, undefined);

// The plugin relies on Paseo drawing thoughts as the tool call "thinking", and on the timeline
// drawing a non-agent tool call from toolName/arguments/status.
assert.match(bundle, /toolName:"thinking",args:\w+,status:\w+/);
assert.match(bundle, /toolName:\w+\.toolName,args:\w+\.arguments,result:\w+\.result,status:\w+\.status/);

// The group label: each count above zero becomes t(`<key>.one|other`, {count}), edited files first.
// label() below repeats that so the check can word real groups with Paseo's own i18next.
assert.match(bundle, /(\w+)>0&&\w+\.push\(\w+\(`\$\{\w+\}\.\$\{1===\1\?"one":"other"\}`,\{count:\1\}\)\)/);
const KEYS = ["editedFiles", "commands", "readFiles", "searches", "otherTools", "paseoCalls"];
const labelModule = [...lines.values()].find((line) => line.includes('"toolCallGroup.paseoCalls"]'));
const keyOrder = KEYS.map((key) => labelModule.indexOf(`"toolCallGroup.${key}"]`));
assert.deepEqual([...keyOrder].sort((a, b) => a - b), keyOrder);
const FIELDS = ["editedFileCount", "commandCount", "readFileCount", "searchCount", "otherToolCount", "paseoCallCount"];
const t = i18n.getFixedT("en", "translation");
function label(summary) {
  const parts = [];
  FIELDS.forEach((field, i) => {
    const count = summary[field];
    if (count > 0) parts.push(t(`toolCallGroup.${KEYS[i]}.${1 === count ? "one" : "other"}`, { count }));
  });
  const and = t("toolCallGroup.and");
  const text = parts.length > 2 ? `${parts.slice(0, -1).join(", ")}, ${and} ${parts.at(-1)}` : parts.join(` ${and} `);
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

// Paseo's own caller, which reaches the grouping functions through the module's exports.
const caller = globalThis.__r(moduleWith("e.prepareToolCallHistory=function"));
function project(tail, head) {
  const preparedHistory = caller.prepareToolCallHistory("overview", tail);
  return caller.projectToolCallDetailLevel({ level: "overview", tail, head, preparedHistory, isTurnActive: true });
}

let n = 0;
const timestamp = new Date(0);
const thought = (turnId, status = "ready") => ({ kind: "thought", id: `think${n++}`, turnId, text: `thought ${n}`, status, timestamp });
const tool = (turnId, detail) => ({
  kind: "tool_call",
  id: `tool${n++}`,
  turnId,
  timestamp,
  payload: { source: "agent", data: { name: detail.type, status: "completed", detail, error: null } },
});
const shell = (turnId) => tool(turnId, { type: "shell", command: "ls" });
const edit = (turnId) => tool(turnId, { type: "edit", filePath: "a.ts" });
const user = (turnId) => ({ kind: "user_message", id: `user${n++}`, turnId, text: "why", timestamp });
const reply = (turnId) => ({ kind: "assistant_message", id: `reply${n++}`, turnId, text: "because", timestamp });

// A finished turn, then a live one shaped like the 22/10/2026 screenshots.
const tail = [user(1), thought(1), shell(1), thought(1), shell(1), thought(1), reply(1)];
const head = [thought(2), shell(2), thought(2), shell(2), shell(2), thought(2), shell(2), thought(2, "loading")];

function rows(projected) {
  const row = (item) => {
    const group = projected.groupsByHostId.get(item.id);
    if (!group) return item.kind;
    const calls = group.run.calls.map((call) => (call.payload.source === "agent" ? call.payload.data.name : "think"));
    return `group(${calls.join(",")})`;
  };
  return { tail: projected.tail.map(row), head: projected.head.map(row) };
}

// Paseo alone: every thought splits the tool calls into another group.
const before = rows(project(tail, head));
assert.deepEqual(before.tail, ["user_message", "thought", "group(shell)", "thought", "group(shell)", "thought", "assistant_message"]);
assert.deepEqual(before.head, ["thought", "group(shell)", "thought", "group(shell,shell)", "thought", "group(shell)", "thought"]);

const unpatch = patch(module, i18n);
const unpatchSecondHost = patch(module, i18n);
const projected = project(tail, head);
const after = rows(projected);
// The thought before the reply and the one being written join the group too.
assert.deepEqual(after.tail, ["user_message", "group(think,shell,think,shell,think)", "assistant_message"]);
assert.deepEqual(after.head, ["group(think,shell,think,shell,shell,think,shell,think)"]);

// The group keeps its first item's ID, and its row, a copy of the last call, keeps the turn.
const [liveRow] = projected.head;
const liveGroup = projected.groupsByHostId.get(liveRow.id);
assert.equal(liveRow.id, head[0].id);
assert.equal(liveRow.kind, "tool_call");
assert.equal(liveRow.turnId, 2);
// It counts commands only, spins while the last thought streams, and says how often it thought.
assert.equal(liveGroup.summary.commandCount, 4);
assert.equal(liveGroup.summary.otherToolCount, 0);
assert.equal(liveGroup.isLoading, true);
assert.equal(label(liveGroup.summary), "Thought 4 times and ran 4 commands");
assert.equal(label(projected.groupsByHostId.get(projected.tail[1].id).summary), "Thought 3 times and ran 2 commands");

// An absorbed thought reads, to Paseo, as the tool call its own thought row draws.
const absorbed = liveGroup.run.calls[0];
assert.ok(module.isGroupableToolCall(absorbed));
assert.deepEqual(module.describeToolCall(absorbed), {
  detail: { type: "unknown", input: head[0].text, output: null },
  name: "thinking",
  status: "completed",
  error: undefined,
});

// Edited files share the label's first slot with the thoughts.
const edits = project([user(3), thought(3), edit(3), thought(3), shell(3), reply(3)], []);
assert.equal(label(edits.groupsByHostId.get(edits.tail[1].id).summary), "Thought 2 times, edited 1 file and ran 1 command");
// Labels without thoughts are Paseo's own.
assert.equal(label({ ...liveGroup.summary, editedFileCount: 2 }), "Edited 2 files and ran 4 commands");

// A run that ends the saved history continues into the live head through its thoughts.
const split = project([user(4), thought(4), shell(4), thought(4)], [thought(4), shell(4)]);
assert.deepEqual(rows(split), { tail: ["user_message", "group(think,shell,think,think,shell)"], head: [] });

// A turn without tool calls is left alone.
assert.deepEqual(rows(project([user(5), thought(5), reply(5)], [])).tail, ["user_message", "thought", "assistant_message"]);

// Thoughts in a row group on their own, like the 23/10/2026 screenshot's four Thinking rows
// between a message and the reply.
const thoughtsOnly = project([user(6), thought(6), thought(6), thought(6), thought(6), reply(6)], []);
assert.deepEqual(rows(thoughtsOnly).tail, ["user_message", "group(think,think,think,think)", "assistant_message"]);
assert.equal(label(thoughtsOnly.groupsByHostId.get(thoughtsOnly.tail[1].id).summary), "Thought 4 times");
// While they stream, the group spins.
const streaming = project([user(7)], [thought(7), thought(7), thought(7, "loading")]);
assert.deepEqual(rows(streaming).head, ["group(think,think,think)"]);
const streamingGroup = streaming.groupsByHostId.get(streaming.head[0].id);
assert.equal(streamingGroup.isLoading, true);
assert.equal(label(streamingGroup.summary), "Thought 3 times");
// Without Paseo's i18next such a group would have no label, so its thoughts stay apart.
const unpatchUnlabeled = patch(module);
assert.deepEqual(rows(project([user(8), thought(8), thought(8), reply(8)], [])).tail, ["user_message", "thought", "thought", "assistant_message"]);
unpatchUnlabeled();

// Every host's copy keeps the merge until the last one unloads; unloading twice is harmless.
unpatch();
unpatch();
assert.deepEqual(rows(project(tail, head)), after);
unpatchSecondHost();
assert.deepEqual(rows(project(tail, head)), before);
assert.equal(module.mergeThinking, undefined);
// Groups Paseo cached still word their thoughts after the unload.
assert.equal(label(liveGroup.summary), "Thought 4 times and ran 4 commands");

// On a reload the newer copy takes over, whether the old copy unloads before or after it loads.
const original = module.prepareGroupedHistory;
const unpatchOld = patch(module, i18n);
const oldCopy = module.prepareGroupedHistory;
const unpatchNew = loadPlugin().patch(module, i18n);
const newCopy = module.prepareGroupedHistory;
assert.notEqual(newCopy, oldCopy);
unpatchOld();
assert.equal(module.prepareGroupedHistory, newCopy);
assert.equal(label(liveGroup.summary), "Thought 4 times and ran 4 commands");
assert.equal(label(project(tail, head).groupsByHostId.get(liveRow.id).summary), "Thought 4 times and ran 4 commands");
unpatchNew();
assert.equal(module.prepareGroupedHistory, original);

// A copy from before that rule keeps its patch, and a new copy says to reload the app window.
const warnings = [];
const { warn } = console;
console.warn = (...args) => warnings.push(args.join(" "));
module.mergeThinking = { loads: 1, restore() {} };
patch(module, i18n)();
console.warn = warn;
assert.equal(module.prepareGroupedHistory, original);
assert.match(warnings.join("\n"), /reload the app window/);
delete module.mergeThinking;
assert.equal(t("toolCallGroup.commands.other", { count: 2 }), "ran 2 commands");
console.log(`ok: ${bundlePath}; ${before.head.length} live rows became ${after.head.length}: "${label(liveGroup.summary)}"`);
