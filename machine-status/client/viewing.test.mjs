// The sidebar's report of which Machine screen is current, without React.
import assert from "node:assert/strict";
import { test } from "node:test";

const { isCurrent, report, subscribe, withdraw } = await import("./viewing.ts");

test("a screen reads until the sidebar reports another screen, and again once it reports this one", () => {
  const ragmini = Symbol("ragmini row");
  const ragdevbox = Symbol("ragdevbox row");
  let calls = 0;
  const stop = subscribe(() => (calls += 1));

  // No row has reported: the screen reads, as it always did.
  assert.equal(isCurrent("srv_mini"), true);

  report(ragmini, "srv_mini", true);
  assert.equal(isCurrent("srv_mini"), true);
  assert.equal(isCurrent("srv_box"), false);

  // Settings opened on top: the same row, no longer current.
  report(ragmini, "srv_mini", false);
  assert.equal(isCurrent("srv_mini"), false);

  // Another host's page: its row replaces this one, which then goes.
  report(ragdevbox, "srv_box", false);
  withdraw(ragmini);
  assert.equal(isCurrent("srv_mini"), false);
  assert.equal(isCurrent("srv_box"), false);

  // The sidebar goes entirely: nothing to ask, so screens read.
  withdraw(ragdevbox);
  assert.equal(isCurrent("srv_mini"), true);

  stop();
  report(ragmini, "srv_mini", true);
  assert.equal(calls, 4);
  withdraw(ragmini);
});
