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

interface ShownFrame { windowId: string | null; hash: string | null; mimeType: Frame["mimeType"] | null }
interface FrameLoopOptions extends Omit<Options, "active" | "refresh"> {
  getShown(): ShownFrame;
  forgetShown(): void;
  onFrame(frame: Frame): void;
  onError(error: string | null): void;
}

/** Separate from React so cancellation and retry behavior can run in Node tests. */
export function startFrameLoop(options: FrameLoopOptions): () => void {
  let stopped = false;
  let timer: Timer | undefined;
  let wake: (() => void) | undefined;
  let failures = 0;
  let received: Frame | null = null;
  const pause = (milliseconds: number) => new Promise((resolve) => {
    wake = () => resolve(undefined);
    timer = setTimeout(wake, milliseconds);
  });

  async function run() {
    while (!stopped) {
      let delay = 30;
      try {
        const shown = options.getShown();
        const since = received && shown.hash === received.hash && shown.windowId === received.windowId &&
          shown.mimeType === received.mimeType && (shown.windowId === options.windowId || options.windowId === null)
          ? shown.hash : null;
        const result = await options.read({
          windowId: options.windowId, maxWidth: options.maxWidth, maxHeight: options.maxHeight,
          quality: options.quality, lossless: options.lossless,
          since,
          waitMs: since === null ? 0 : 1500,
        });
        if (stopped) break;
        received = result;
        if (result.status !== "ready" || (result.windowId !== options.getShown().windowId && !result.image)) {
          options.forgetShown();
        }
        options.onFrame(result);
        options.onError(null);
        failures = 0;
        if (result.status !== "ready") delay = result.status === "not-running" ? 1000 : 1500;
      } catch (cause) {
        if (stopped) break;
        options.onError(cause instanceof Error ? cause.message : String(cause));
        delay = Math.min(5000, 1000 * 2 ** failures++);
      }
      if (!stopped) await pause(delay);
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
  const shown = useRef<ShownFrame>({ windowId: null, hash: null, mimeType: null });
  const running = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    const stop = startFrameLoop({
      read, windowId, maxWidth, maxHeight, quality, lossless,
      getShown: () => shown.current,
      forgetShown: () => { shown.current = { windowId: null, hash: null, mimeType: null }; },
      onFrame: (result) => setFrame((previous) => retainFrameImage(previous, result)),
      onError: setError,
    });
    running.current = stop;
    return () => {
      stop();
      if (running.current === stop) running.current = null;
    };
  }, [active, read, windowId, maxWidth, maxHeight, quality, lossless, refresh]);

  const didDisplay = useCallback((frame: Frame) => {
    shown.current = { windowId: frame.windowId, hash: frame.hash, mimeType: frame.mimeType };
  }, []);
  const clear = useCallback(() => {
    running.current?.();
    running.current = null;
    shown.current = { windowId: null, hash: null, mimeType: null };
    setFrame(null);
    setError(null);
  }, []);
  return { frame, error, didDisplay, clear };
}
