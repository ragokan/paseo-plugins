import assert from "node:assert/strict";
import { test } from "node:test";

const { readFirstMessage } = await import("./agent-title.ts");

const empty = { hasOlder: false, entries: [] };
const started = { hasOlder: false, entries: [{ item: { type: "user_message", text: "Rename the userId column" } }] };

function pages(...sequence) {
  let calls = 0;
  const fetchPage = async () => sequence[Math.min(calls++, sequence.length - 1)];
  return { fetchPage, calls: () => calls };
}

test("Codex's first message lands after its turn starts, so the timeline is read again", async () => {
  const { fetchPage, calls } = pages(empty, empty, started);
  assert.deepEqual(await readFirstMessage(fetchPage, new AbortController().signal, [0, 0, 0, 0]), { kind: "found", text: "Rename the userId column" });
  assert.equal(calls(), 3);
});

test("a message that never comes is left for the turn's end", async () => {
  const { fetchPage, calls } = pages(empty);
  assert.deepEqual(await readFirstMessage(fetchPage, new AbortController().signal, [0, 0]), { kind: "not-yet" });
  assert.equal(calls(), 3);
});

test("an agent already past its first page is not read again", async () => {
  const { fetchPage, calls } = pages({ hasOlder: true, entries: [] });
  assert.deepEqual(await readFirstMessage(fetchPage, new AbortController().signal, [0, 0]), { kind: "out-of-reach" });
  assert.equal(calls(), 1);
});
