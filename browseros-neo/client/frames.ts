import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcInput } from "@getpaseo/plugin";
import type { Frame, readFrame } from "../shared/contracts.ts";
import type { OptionalText, Timer } from "./logic.ts";
import { retainFrameImage } from "./frame-buffer.ts";

type ReadContract = typeof readFrame;

interface Options {
  active: boolean;
  read(input: RpcInput<ReadContract>): Promise<Frame>;
  windowId: string | null;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  lossless: boolean;
  refresh: number;
}

interface FrameLoopOptions extends Omit<Options, "active" | "refresh"> {
  onFrame(frame: Frame): void;
  onError(error: string | null): void;
}

/** Separate from React so cancellation and retry behavior can run in Node tests. */
export function startFrameLoop(options: FrameLoopOptions): () => void {
  let stopped = false;
  let timer: Timer | undefined;
  let wake: (() => void) | undefined;
  let failures = 0;
  let since: string | null = null;
  const bytesPerMs = (options.lossless ? 5 : 3) * 1024 * 1024 / 1000;
  const capacity = bytesPerMs * 500;
  let tokens = capacity;
  let refilledAt = Date.now();
  function refill(now: number) {
    tokens = Math.min(capacity, tokens + Math.max(0, now - refilledAt) * bytesPerMs);
    refilledAt = now;
  }
  const pause = (milliseconds: number) => new Promise((resolve) => {
    wake = () => resolve(undefined);
    timer = setTimeout(wake, milliseconds);
  });

  async function run() {
    while (!stopped) {
      const startedAt = Date.now();
      let delay = 0;
      try {
        const result = await options.read({
          windowId: options.windowId, maxWidth: options.maxWidth, maxHeight: options.maxHeight,
          quality: options.quality, lossless: options.lossless,
          since,
          waitMs: since === null ? 0 : 1500,
        });
        if (stopped) break;
        refill(Date.now());
        // Base64 is ASCII: its character count approximates bytes on the wire.
        tokens -= (result.image?.length ?? 0) + 1024;
        since = result.status === "ready" ? result.hash : null;
        options.onFrame(result);
        options.onError(null);
        failures = 0;
        if (result.status !== "ready") delay = result.status === "not-running" ? 1000 : 1500;
      } catch (cause) {
        if (stopped) break;
        options.onError(cause instanceof Error ? cause.message : String(cause));
        delay = Math.min(5000, 1000 * 2 ** failures++);
      }
      const now = Date.now();
      refill(now);
      delay = Math.ceil(Math.max(delay, 1000 / 30 - (now - startedAt), -tokens / bytesPerMs));
      if (!stopped && delay > 0) await pause(delay);
    }
  }
  void run();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    wake?.();
  };
}

export function useFrames({ active, read, windowId, maxWidth, maxHeight, quality, lossless, refresh }: Options) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<OptionalText>(null);
  const latest = useRef<Frame | null>(null);
  const running = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    const stop = startFrameLoop({
      read, windowId, maxWidth, maxHeight, quality, lossless,
      onFrame: (result) => {
        latest.current = retainFrameImage(latest.current, result);
        setFrame(latest.current);
      },
      onError: setError,
    });
    running.current = stop;
    return () => {
      stop();
      if (running.current === stop) running.current = null;
    };
  }, [active, read, windowId, maxWidth, maxHeight, quality, lossless, refresh]);

  const getLatestFrame = useCallback(() => latest.current, []);
  const clear = useCallback(() => {
    running.current?.();
    running.current = null;
    latest.current = null;
    setFrame(null);
    setError(null);
  }, []);
  return { frame, error, getLatestFrame, clear };
}
