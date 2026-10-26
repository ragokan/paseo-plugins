declare const console: { warn(...args: unknown[]): void };

const failed = new Set<string>();

/**
 * change(value), or value as Paseo made it if change throws. The tweaks rewrite what Paseo's own code
 * makes, so one that no longer fits after a Paseo update leaves that part of the app as Paseo has it
 * instead of breaking it. Warns once per tweak.
 */
export function guarded<T>(tweak: string, value: T, change: (value: T) => T): T {
  try {
    return change(value);
  } catch (error) {
    if (!failed.has(tweak)) {
      failed.add(tweak);
      console.warn(`[tweaks] ${tweak} failed, so Paseo's own is used`, error);
    }
    return value;
  }
}
