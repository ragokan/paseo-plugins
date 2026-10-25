import type { InputEvent } from "../shared/contracts.ts";

interface Batch { windowId: string; events: InputEvent[] }
type Send = (batch: Batch) => Promise<{ ok: boolean; error: string | null }>;
type Release = Extract<InputEvent, { type: "up" }>;

/** A window id travels with its input, even if the picker changes while sending. */
export function createInputQueue(send: Send, onError: (message: string) => void, enabled = true) {
  const batches: Batch[] = [];
  const held = new Map<string, { windowId: string; event: Release }>();
  let sending = false;
  let scheduled = false;
  let reporting = true;

  function track(batch: Batch) {
    for (const event of batch.events) {
      if ("x" in event) {
        for (const press of held.values()) {
          if (press.windowId === batch.windowId) press.event = { ...press.event, x: event.x, y: event.y };
        }
      }
      if (event.type === "down") {
        held.set(`${batch.windowId}:${event.button}`, {
          windowId: batch.windowId, event: { type: "up", x: event.x, y: event.y, button: event.button },
        });
      } else if (event.type === "up") held.delete(`${batch.windowId}:${event.button}`);
    }
  }

  async function flush() {
    scheduled = false;
    if (sending) return;
    sending = true;
    try {
      let batch: Batch | undefined;
      while ((batch = batches.shift())) {
        track(batch);
        try {
          const result = await send(batch);
          if (!result.ok && reporting) onError(result.error ?? "BrowserOS could not receive input.");
        } catch (error) {
          if (reporting) onError(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      sending = false;
    }
  }

  function schedule() {
    if (!sending && !scheduled && batches.length) {
      scheduled = true;
      void Promise.resolve().then(flush);
    }
  }

  function disconnect() {
    enabled = false;
    batches.length = 0;
    // Already sent/in-flight downs must be released after that RPC completes.
    // Keep them tracked until dispatch so repeated cleanup cannot drop releases.
    for (const press of held.values()) {
      let batch = batches[batches.length - 1];
      if (!batch || batch.windowId !== press.windowId || batch.events.length >= 200) {
        batch = { windowId: press.windowId, events: [] };
        batches.push(batch);
      }
      batch.events.push(press.event);
    }
    schedule();
  }

  function push(windowId: string, event: InputEvent) {
    if (!enabled) return;
    if (event.type === "text" && event.text.length > 10_000) {
      // Avoid cutting a Unicode surrogate pair at the contract's size boundary.
      let chunk = "";
      for (const character of event.text) {
        if (chunk.length + character.length > 10_000) {
          push(windowId, { type: "text", text: chunk });
          chunk = "";
        }
        chunk += character;
      }
      if (chunk) push(windowId, { type: "text", text: chunk });
      return;
    }
    let batch = batches[batches.length - 1];
    const previous = batch?.events[batch.events.length - 1];
    if (batch?.windowId === windowId && previous?.type === "move" && event.type === "move") {
      batch.events[batch.events.length - 1] = event;
    } else {
      if (!batch || batch.windowId !== windowId || batch.events.length >= 200) {
        batch = { windowId, events: [] };
        batches.push(batch);
      }
      batch.events.push(event);
    }
    schedule();
  }

  return {
    push,
    connect() { enabled = true; },
    disconnect,
    activate() { reporting = true; },
    dispose() { reporting = false; disconnect(); },
  };
}
