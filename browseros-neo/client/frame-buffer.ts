import type { Frame } from "../shared/contracts.ts";

export function sameFramePixels(left: Frame | null, right: Frame): boolean {
  return Boolean(left?.hash && left.hash === right.hash && left.windowId === right.windowId && left.mimeType === right.mimeType);
}

export function frameKey(frame: Pick<Frame, "windowId" | "mimeType" | "hash">): string {
  return `${frame.windowId}:${frame.mimeType}:${frame.hash}`;
}

export function frameImageUri(mimeType: Frame["mimeType"], image: string): string {
  return `data:${mimeType};base64,${image}`;
}

/** Metadata can change while the JPEG stays identical, including after a fit. */
export function bufferedFrame(frame: Frame, cached: readonly (Frame | null)[]): Frame | null {
  if (frame.status !== "ready" || !frame.hash) return null;
  if (frame.image) return frame;
  const image = cached.find((item) => sameFramePixels(item, frame))?.image;
  return image ? { ...frame, image } : null;
}

/** Finish this decode; the next decode uses the latest frame, skipping intermediates. */
export function decodedFrame(latest: Frame | null, completed: Frame): Frame | null {
  if (latest?.status !== "ready" || latest.windowId !== completed.windowId) return null;
  return sameFramePixels(completed, latest) ? bufferedFrame(latest, [completed]) : completed;
}

export function retainFrameImage(previous: Frame | null, next: Frame): Frame {
  if (previous && !next.changed && !next.image && next.status === "ready" &&
      sameFramePixels(previous, next)) {
    return { ...next, image: previous.image };
  }
  return next;
}
