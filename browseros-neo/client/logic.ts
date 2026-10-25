import type { InputEvent, KeyModifier, MouseButton } from "../shared/contracts.ts";

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export type OptionalText = string | null;
type TimeoutFunction = typeof setTimeout;
export type Timer = ReturnType<TimeoutFunction>;

export function fitSize(box: Size, image: Size, allowUpscale = false): Size {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(allowUpscale ? Infinity : 1, box.width / image.width, box.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

export function mapPoint(point: Point, drawn: Size, remote: Size): Point | null {
  if (drawn.width <= 0 || drawn.height <= 0 || remote.width <= 0 || remote.height <= 0) return null;
  return {
    x: Math.max(0, Math.min(remote.width - 1, Math.floor(point.x * remote.width / drawn.width))),
    y: Math.max(0, Math.min(remote.height - 1, Math.floor(point.y * remote.height / drawn.height))),
  };
}

export function captureDimension(size: number): number {
  return Math.max(64, Math.min(8192, Math.round(size)));
}

/** Retain trackpad/finger fractions between events, including direction changes. */
export class NotchAccumulator {
  private x = 0;
  private y = 0;

  take(dx: number, dy: number, pixelsPerNotch = 60): { dx: number; dy: number } {
    this.x += dx / pixelsPerNotch;
    this.y += dy / pixelsPerNotch;
    const x = Math.max(-50, Math.min(50, Math.trunc(this.x)));
    const y = Math.max(-50, Math.min(50, Math.trunc(this.y)));
    this.x -= x;
    this.y -= y;
    return { dx: x || 0, dy: y || 0 };
  }
}

export const TOUCH_HOLD_MS = 500;
export type TouchAction =
  | { type: "click"; point: Point; button: "left" | "right" }
  | { type: "scroll"; point: Point; dx: number; dy: number };

/** Classify in local display pixels, independently of the remote image's scale. */
export class TouchGesture {
  private start: Point;
  private previous: Point;
  private latest: Point;
  private startedAt: number;
  private dragging = false;
  private held = false;
  private finished = false;
  private scroll = new NotchAccumulator();

  constructor(point: Point, now: number) {
    this.start = this.previous = this.latest = point;
    this.startedAt = now;
  }

  get isDragging() { return this.dragging; }

  move(point: Point): TouchAction | null {
    if (this.finished || this.held) return null;
    this.latest = point;
    if (!this.dragging && Math.hypot(point.x - this.start.x, point.y - this.start.y) < 10) return null;
    this.dragging = true;
    const notches = this.scroll.take(this.previous.x - point.x, this.previous.y - point.y, 40);
    this.previous = point;
    return notches.dx || notches.dy ? { type: "scroll", point: this.start, ...notches } : null;
  }

  hold(now: number): TouchAction | null {
    if (this.finished || this.dragging || this.held || now - this.startedAt < TOUCH_HOLD_MS) return null;
    this.held = true;
    return { type: "click", point: this.latest, button: "right" };
  }

  end(point: Point, now: number): TouchAction | null {
    if (this.finished) return null;
    const movement = this.move(point);
    const click: TouchAction | null = this.dragging || this.held ? null
      : this.hold(now) ?? { type: "click", point, button: "left" };
    this.finished = true;
    return movement ?? click;
  }
}

export function wheelPixels(dx: number, dy: number, mode: number, pageHeight: number): Point {
  const multiplier = mode === 1 ? 16 : mode === 2 ? pageHeight : 1;
  return { x: dx * multiplier, y: dy * multiplier };
}

export function mouseButton(button: number): MouseButton | null {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function isPasteShortcut(event: KeyLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
}

export function keyInput(event: KeyLike): InputEvent | null {
  if (event.isComposing || isPasteShortcut(event) ||
      ["Control", "Meta", "Alt", "Shift", "Dead", "Process", "Unidentified"].includes(event.key)) return null;
  if (Array.from(event.key).length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return { type: "text", text: event.key };
  }
  if (!event.key || event.key.length > 32) return null;
  const modifiers: KeyModifier[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("ctrl");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("alt");
  return { type: "key", key: event.key, modifiers };
}

export function textChange(before: string, after: string): { inserted: string; removed: number } {
  const previous = Array.from(before);
  const next = Array.from(after);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = 0;
  while (end < previous.length - start && end < next.length - start &&
      previous[previous.length - end - 1] === next[next.length - end - 1]) end++;
  return {
    inserted: next.slice(start, next.length - end).join(""),
    removed: previous.length - start - end,
  };
}
