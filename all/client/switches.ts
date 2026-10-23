import type { PluginClientContext } from "@getpaseo/plugin/client";

declare const console: { warn(...args: unknown[]): void };

type Cleanup = () => void | Promise<void>;
export type Contribution = (client: PluginClientContext) => Cleanup | void;

// Paseo removes a plugin's registrations only when the whole plugin stops, and some bundled plugins
// rely on that (their cleanup is empty). So each one gets a client that records what it adds, and
// switching it off removes those registrations after running its own cleanup.
function start(id: string, client: PluginClientContext, contribute: Contribution): Cleanup {
  const removers: Array<() => void> = [];
  const scoped = new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (typeof key !== "string" || !key.startsWith("add")) return value.bind(target);
      return (...args: unknown[]) => {
        const registration: unknown = value.apply(target, args);
        // add* returns a remover, or for buttons and pills an object with remove().
        if (typeof registration === "function") removers.push(registration as () => void);
        else if (registration && typeof (registration as { remove?: unknown }).remove === "function") {
          removers.push(() => (registration as { remove(): void }).remove());
        }
        return registration;
      };
    },
  });
  const removeAll = () => {
    for (const remove of removers.splice(0)) remove();
  };
  let cleanup: Cleanup | void;
  try {
    cleanup = contribute(scoped);
  } catch (error) {
    console.warn(`[all] ${id} failed to start`, error);
    removeAll();
    return () => {};
  }
  return async () => {
    try {
      await cleanup?.();
    } catch (error) {
      console.warn(`[all] ${id} failed to stop`, error);
    }
    removeAll();
  };
}

/** Runs the bundled plugins whose switch is on. Changes apply in order, one at a time. */
export function createSwitches<Id extends string>(client: PluginClientContext, contributions: Record<Id, Contribution>) {
  const running = new Map<Id, Cleanup>();
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  const sync = (enabled: Partial<Record<Id, boolean>>) => {
    queue = queue.then(async () => {
      for (const id of Object.keys(contributions) as Id[]) {
        const stop = running.get(id);
        if (enabled[id] && !stop) running.set(id, start(id, client, contributions[id]));
        else if (!enabled[id] && stop) {
          running.delete(id);
          await stop();
        }
      }
    });
    return queue;
  };

  return {
    apply(enabled: Record<Id, boolean>) {
      return disposed ? queue : sync(enabled);
    },
    dispose() {
      disposed = true;
      return sync({});
    },
  };
}
