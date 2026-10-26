import { useCallback, useLayoutEffect, useMemo } from "react";
import type { Size, Timer } from "./logic.ts";

interface FitResult { ok: boolean }
type Fit = (size: Size) => Promise<FitResult>;

export function displaySize(box: Size): Size | null {
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return null;
  return {
    width: Math.max(100, Math.min(8192, Math.round(box.width))),
    height: Math.max(100, Math.min(8192, Math.round(box.height))),
  };
}

/** Resize debounce and interaction ownership are independent of frame updates. */
export function createDisplayFitter(fit: Fit) {
  let active = false;
  let size: Size | null = null;
  let lastCall = -Infinity;
  let timer: Timer | undefined;

  function cancel() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function apply() {
    cancel();
    if (!active || !size) return;
    lastCall = Date.now();
    // A real monitor or an older daemon can decline; scaled frames still work.
    try { void fit(size).catch(() => {}); } catch { /* Fitting is optional. */ }
  }

  return {
    update(visible: boolean, box: Size) {
      const next = displaySize(box);
      const wasActive = active;
      const changed = next?.width !== size?.width || next?.height !== size?.height;
      active = visible && next !== null;
      size = next;
      if (!active) cancel();
      else if (!wasActive) apply();
      else if (changed) {
        cancel();
        timer = setTimeout(apply, 500);
      }
    },
    interact() {
      if (Date.now() - lastCall >= 3000) apply();
    },
    pause() { active = false; cancel(); },
  };
}

export function useDisplayFit(fit: Fit, active: boolean, box: Size) {
  const fitter = useMemo(() => createDisplayFitter(fit), [fit]);
  useLayoutEffect(() => () => fitter.pause(), [fitter]);
  useLayoutEffect(() => { fitter.update(active, box); }, [fitter, active, box.width, box.height]);
  const interact = useCallback(() => fitter.interact(), [fitter]);
  const pause = useCallback(() => fitter.pause(), [fitter]);
  return { interact, pause };
}
