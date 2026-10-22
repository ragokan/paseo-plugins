import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const document: { scripts: ArrayLike<{ src: string }> };
declare function fetch(url: string): Promise<{ text(): Promise<string> }>;
declare const console: { warn(...args: unknown[]): void };

// The fields of Paseo's stream items, tool call groups and i18next instance this plugin uses.
export interface StreamItem {
  kind: string;
  id: string;
  timestamp: Date;
  text?: string;
  status?: string;
  payload?: { source: string; data: { status?: string; [field: string]: unknown } };
}
interface ToolCallRun {
  id: string;
  calls: StreamItem[];
}
interface ToolCallGroup {
  run: ToolCallRun;
  isLoading: boolean;
  summary: { editedFileCount: number | ThoughtCount };
}
type BuildGroup = (run: ToolCallRun) => ToolCallGroup;
interface GroupingInput {
  tail?: StreamItem[];
  head?: StreamItem[];
  history?: { pendingCalls: StreamItem[] };
  buildGroup: BuildGroup;
  [other: string]: unknown;
}
type Grouping = (input: GroupingInput) => unknown;
interface GroupingModule {
  isGroupableToolCall(item: StreamItem): boolean;
  prepareGroupedHistory: Grouping;
  groupLiveToolCalls: Grouping;
  mergeThinking?: { original: GroupingFunctions; copies: GroupingFunctions[] };
}
type GroupingFunctions = Pick<GroupingModule, "prepareGroupedHistory" | "groupLiveToolCalls">;
interface I18n {
  t(...args: unknown[]): string;
  mergeThinking?: { t: I18n["t"] };
}

const SOURCE = "merge-thinking";

// Paseo draws a thought as a generic tool call named "thinking". As one, it groups with tool
// calls, and the expanded group draws it with the same props as Paseo's own thought row. It keeps
// the thought's other fields, such as turnId, which the timeline lays rows out by.
function asToolCall({ text, status, ...thought }: StreamItem): StreamItem {
  const toolStatus = status === "ready" ? "completed" : "executing";
  return { ...thought, kind: "tool_call", payload: { source: SOURCE, data: { toolName: "thinking", arguments: text, status: toolStatus } } };
}

/**
 * Turns each thought next to a groupable tool call, ignoring other thoughts in between, into a
 * "thinking" tool call so it joins that call's group. `toolBefore` says whether a tool call run
 * comes right before `items`. Returns `items` itself when nothing changes.
 */
export function absorbThoughts(items: StreamItem[], isGroupable: (item: StreamItem) => boolean, toolBefore = false): StreamItem[] {
  const toolAfter: boolean[] = [];
  let tool = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === "thought") toolAfter[i] = tool;
    else tool = isGroupable(items[i]!);
  }
  tool = toolBefore;
  let out: StreamItem[] | undefined;
  items.forEach((item, i) => {
    if (item.kind !== "thought") tool = isGroupable(item);
    else if (tool || toolAfter[i]) (out ??= [...items])[i] = asToolCall(item);
  });
  return out ?? items;
}

// Paseo's group label words its first count, edited files, with i18next's t(). A thought count
// takes that slot: it compares as a count above zero, and the wrapped t() words it.
interface ThoughtCount {
  mergeThinking: "thoughts";
  thoughts: number;
  editedFiles: number;
  valueOf(): number;
}
function thoughtCount(thoughts: number, editedFiles: number): ThoughtCount {
  return { mergeThinking: "thoughts", thoughts, editedFiles, valueOf: () => thoughts + editedFiles };
}

// The wrapper stays after the plugin unloads, since groups Paseo cached keep their thought counts,
// and it finds counts by a field rather than a class so it words a reloaded copy's counts too.
// Each copy rewraps Paseo's own t(), so the newest copy's wording runs.
function wordThoughtCounts(i18n: I18n) {
  const t = i18n.mergeThinking?.t ?? i18n.t;
  i18n.t = function (this: I18n, ...args: unknown[]) {
    const options = args[1] as { count?: Partial<ThoughtCount> } | undefined;
    const count = options?.count;
    if (count?.mergeThinking !== "thoughts") return t.apply(this, args);
    // shortcut: English only; add the phrase to Paseo's i18next resources if other languages need it.
    const thoughts = `thought ${count.thoughts} ${count.thoughts === 1 ? "time" : "times"}`;
    if (!count.editedFiles) return thoughts;
    const plural = count.editedFiles === 1 ? "one" : "other";
    return `${thoughts}, ${t.call(this, `toolCallGroup.editedFiles.${plural}`, { ...options, count: count.editedFiles })}`;
  };
  i18n.mergeThinking = { t };
}

// The group's tool counts leave thoughts out, while its expanded view still lists every call.
function withThoughts(buildGroup: BuildGroup, labelThoughts: boolean): BuildGroup {
  return (run) => {
    const thoughts = run.calls.filter((call) => call.payload?.source === SOURCE);
    if (thoughts.length === 0) return buildGroup(run);
    const group = buildGroup({ ...run, calls: run.calls.filter((call) => call.payload?.source !== SOURCE) });
    const { editedFileCount } = group.summary;
    return {
      ...group,
      run,
      isLoading: group.isLoading || thoughts.some((call) => call.payload!.data.status === "executing"),
      summary: labelThoughts ? { ...group.summary, editedFileCount: thoughtCount(thoughts.length, Number(editedFileCount)) } : group.summary,
    };
  };
}

// shortcut: the plugin SDK only transforms one timeline item at a time and has no label API, so
// this finds the app's tool call grouping and i18next modules in its Metro bundle and wraps
// prepareGroupedHistory, groupLiveToolCalls and t(), which the app calls through those objects.
// Desktop/web only, and breaks if Paseo renames them; switch to an SDK call once one exists.
export async function findModules(): Promise<{ grouping: GroupingModule; i18n?: I18n }> {
  const bundle = Array.from(document.scripts).find((script) => script.src.includes("/_expo/static/js/"));
  if (!bundle) throw new Error("Paseo app bundle not found");
  const source = await (await fetch(bundle.src)).text();
  const metroRequire = (globalThis as { __r?: (id: number) => unknown }).__r;
  const moduleWith = (needle: string) => {
    const start = source.indexOf(needle);
    // Each Metro module ends its last line with `},<moduleId>,[<deps>]);`.
    const end = /\},(\d+),\[[\d,]*\]\);(?:\n|$)/g;
    end.lastIndex = start;
    const moduleId = start < 0 ? undefined : end.exec(source)?.[1];
    return moduleId && metroRequire ? metroRequire(Number(moduleId)) : undefined;
  };
  const grouping = moduleWith(".prepareGroupedHistory=function") as Partial<GroupingModule> | undefined;
  if (
    typeof grouping?.prepareGroupedHistory !== "function" ||
    typeof grouping.groupLiveToolCalls !== "function" ||
    typeof grouping.isGroupableToolCall !== "function"
  ) {
    throw new Error("Paseo tool call grouping not found");
  }
  // Without the app's i18next instance, groups still merge; their labels just leave thoughts out.
  const i18n = (moduleWith(".initReactI18next).init(") as { i18n?: Partial<I18n> } | undefined)?.i18n;
  return { grouping: grouping as GroupingModule, i18n: typeof i18n?.t === "function" ? (i18n as I18n) : undefined };
}

// The app loads this plugin once per host that has it installed, and again on every reload. The
// newest copy still loaded runs, so an update takes over, and the last to unload restores Paseo's.
export function patch(module: GroupingModule, i18n?: I18n): () => void {
  // Copies before 22/10/2026 15:45 kept the first copy's patch; theirs stays until the app reloads.
  if (module.mergeThinking && !module.mergeThinking.copies) {
    console.warn("[merge-thinking] an older copy is active; reload the app window to update it");
    return () => {};
  }
  const state = (module.mergeThinking ??= {
    original: { prepareGroupedHistory: module.prepareGroupedHistory, groupLiveToolCalls: module.groupLiveToolCalls },
    copies: [],
  });
  const { original } = state;
  const { isGroupableToolCall } = module;
  if (i18n) wordThoughtCounts(i18n);
  const copy: GroupingFunctions = {
    prepareGroupedHistory: (input) =>
      original.prepareGroupedHistory({
        ...input,
        tail: absorbThoughts(input.tail!, isGroupableToolCall),
        buildGroup: withThoughts(input.buildGroup, !!i18n),
      }),
    groupLiveToolCalls: (input) =>
      original.groupLiveToolCalls({
        ...input,
        head: absorbThoughts(input.head!, isGroupableToolCall, input.history!.pendingCalls.length > 0),
        buildGroup: withThoughts(input.buildGroup, !!i18n),
      }),
  };
  state.copies.push(copy);
  Object.assign(module, copy);
  return () => {
    const index = state.copies.indexOf(copy);
    if (index < 0) return;
    state.copies.splice(index, 1);
    Object.assign(module, state.copies.at(-1) ?? original);
    if (state.copies.length === 0) delete module.mergeThinking;
  };
}

export default function contribute(_client: PluginClientContext) {
  // The module lookup reads the web bundle, so iOS and Android keep Paseo's own grouping.
  if (Platform.OS !== "web") return () => {};
  const unpatch = findModules().then(
    ({ grouping, i18n }) => patch(grouping, i18n),
    (error) => {
      console.warn("[merge-thinking]", error);
      return () => {};
    },
  );
  return async () => (await unpatch)();
}
