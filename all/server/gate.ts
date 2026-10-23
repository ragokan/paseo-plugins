import type { PluginServerContext } from "@getpaseo/plugin/server";

type Handler = (...args: unknown[]) => unknown;

// Paseo accepts RPC handlers only while the server entry runs, so a bundled plugin registers once
// at startup and its switch is checked on every call: RPCs fail and hooks pass through while it is off.
export function gate(server: PluginServerContext, id: string, isOn: () => boolean): PluginServerContext {
  return new Proxy(server, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "handle") {
        return (contract: unknown, handler: Handler) =>
          value.call(target, contract, (...args: unknown[]) => {
            if (!isOn()) throw new Error(`${id} is switched off in the all plugin's Features settings`);
            return handler(...args);
          });
      }
      if (key === "on" || key === "before") {
        return (name: unknown, handler: Handler) =>
          value.call(target, name, (...args: unknown[]) => (isOn() ? handler(...args) : undefined));
      }
      return value.bind(target);
    },
  });
}
