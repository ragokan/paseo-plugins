import assert from "node:assert/strict";
import { test } from "node:test";

const { candidates, defaultTitle, firstMessage, hasDefaultTitle, parseTitle, userPrompt } = await import("./title.ts");

const user = (text) => ({ item: { type: "user_message", text } });
const assistant = (text) => ({ item: { type: "assistant_message", text } });

test("the default title is the prompt's first line, spaces collapsed, cut to 60 characters", () => {
  // Titles Paseo 0.13.0 gave agents on this machine.
  assert.equal(
    defaultTitle('Is it possible to have "title generate" plugin for agent tabs inside paseo workspaces?'),
    'Is it possible to have "title generate" plugin for agent tab',
  );
  assert.equal(defaultTitle("Which plugins do we have here?"), "Which plugins do we have here?");
  assert.equal(defaultTitle("\n\n  Fix   the\tlogin test  \nand more"), "Fix the login test");
  assert.equal(defaultTitle(" \n "), null);
});

test("an agent nobody named keeps the default title, or none", () => {
  const message = 'Is it possible to have "title generate" plugin for agent tabs inside paseo workspaces?';
  assert.equal(hasDefaultTitle('Is it possible to have "title generate" plugin for agent tab', message), true);
  assert.equal(hasDefaultTitle(null, message), true);
  assert.equal(hasDefaultTitle("VM3-LI LinkedIn startups (250 more)", "Search LinkedIn for startups"), false, "named by its starter");
  assert.equal(hasDefaultTitle("Add title generation plugin", message), false, "already titled");
});

test("the first message is found only on a page that reaches the start", () => {
  assert.deepEqual(firstMessage({ hasOlder: false, entries: [user("Fix it"), assistant("Done"), user("Thanks")] }), { kind: "found", text: "Fix it" });
  assert.deepEqual(firstMessage({ hasOlder: true, entries: [user("Later message")] }), { kind: "out-of-reach" });
  assert.deepEqual(firstMessage({ hasOlder: false, entries: [] }), { kind: "not-yet" });
});

const providers = [
  { provider: "claude", enabled: true, models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-haiku-5-5", label: "Haiku 5.5" }] },
  { provider: "codex", enabled: true, models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 mini" }, { id: "gpt-6.1-sol", label: "Sol 6.1" }] },
  { provider: "opencode", enabled: true, models: [{ id: "minimax-m3", label: "MiniMax M3" }] },
];

test("Manual mode tries only the configured models", () => {
  const configured = [{ provider: "claude", model: "claude-haiku-5-5" }, { provider: "opencode" }, { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "high" }];
  assert.deepEqual(candidates(configured, providers, { provider: "claude", model: "claude-opus-5-5" }), [
    { provider: "claude", model: "claude-haiku-5-5" },
    { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "high" },
  ]);
});

test("Automatic mode tries the built-in defaults the providers have, then the agent's own model", () => {
  assert.deepEqual(candidates([], providers, { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "xhigh" }), [
    { provider: "claude", model: "claude-haiku-5-5" },
    { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
    { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "xhigh" },
  ]);
  const disabledClaude = providers.map((entry) => (entry.provider === "claude" ? { ...entry, enabled: false } : entry));
  assert.deepEqual(candidates([], disabledClaude, { provider: "claude", model: "claude-haiku-5-5" }), [
    { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
    { provider: "claude", model: "claude-haiku-5-5" },
  ]);
  assert.deepEqual(candidates([], providers, { provider: "claude", model: "claude-haiku-5-5" }).length, 2, "the agent's model once");
});

test("a model's title is one line of at most 80 characters", () => {
  assert.equal(parseTitle("  Fix flaky\nlogin test "), "Fix flaky login test");
  assert.equal(parseTitle("x".repeat(100)).length, 80);
  assert.equal(parseTitle(""), null);
  assert.equal(parseTitle(undefined), null);
});

test("a long first message is cut to fit one command argument", () => {
  assert.ok(userPrompt("y".repeat(200_000)).length < 128 * 1024);
});
