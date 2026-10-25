import { Platform } from "react-native";
import type { InputEvent, MouseButton } from "../shared/contracts.ts";
import {
  isPasteShortcut, keyInput, mapPoint, mouseButton, NotchAccumulator, TOUCH_HOLD_MS, TouchGesture, wheelPixels,
  type KeyLike, type Point, type Size, type Timer, type TouchAction,
} from "./logic.ts";

export type ViewNode = unknown;

// Only the DOM surface used by this adapter. The client has no DOM library.
interface EventLike {
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}
interface PointerLike extends EventLike {
  clientX: number;
  clientY: number;
  button: number;
  pointerId: number;
  pointerType?: string;
  isPrimary?: boolean;
}
interface WheelLike extends PointerLike { deltaX: number; deltaY: number; deltaMode: number }
interface KeyboardLike extends EventLike, KeyLike {}
interface PasteLike extends EventLike { clipboardData?: { getData(type: string): string } }
interface EventTargetLike {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void;
}
interface ElementLike extends EventTargetLike {
  getClientRects(): { length: number };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  contains(node: unknown): boolean;
  focus(options?: { preventScroll: boolean }): void;
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: { touchAction: string; userSelect: string; outline: string };
}
declare const window: EventTargetLike;
declare const document: EventTargetLike & { hidden: boolean };
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(element: ElementLike): void;
  disconnect(): void;
}

export function watchShown(node: unknown, onChange: (shown: boolean) => void): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const element = node as Partial<ElementLike> | null;
  if (typeof element?.getClientRects !== "function") return () => {};
  const check = () => onChange(!document.hidden && element.getClientRects!().length > 0);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
  observer?.observe(element as ElementLike);
  document.addEventListener("visibilitychange", check);
  check();
  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", check);
  };
}

interface PointerOptions {
  remote: Size | (() => Size);
  send(event: InputEvent): void;
  onFocus(focused: boolean): void;
  onInteract?(): void;
}

/** The node is the exact drawn image box, with no letterbox padding. */
export function bindViewer(node: unknown, { remote, send, onFocus, onInteract }: PointerOptions): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined" || typeof document === "undefined") return () => {};
  const element = node as Partial<ElementLike> | null;
  if (typeof element?.getBoundingClientRect !== "function" || typeof element.addEventListener !== "function") return () => {};
  const target = element as ElementLike;
  let focused = false;
  let lastPoint: Point | null = null;
  let lastClient: Point | null = null;
  let lastSent: Point | null = null;
  let lastMoveAt = 0;
  let moveTimer: Timer | undefined;
  let touch: { pointerId: number; gesture: TouchGesture; timer?: Timer } | null = null;
  const held = new Map<MouseButton, number>();
  const wheel = new NotchAccumulator();
  const removers: (() => void)[] = [];
  const oldTab = target.getAttribute("tabindex");
  const oldStyle = { touchAction: target.style.touchAction, userSelect: target.style.userSelect, outline: target.style.outline };
  target.setAttribute("tabindex", "0");
  target.style.touchAction = "none";
  target.style.userSelect = "none";
  target.style.outline = "none";

  function listen<T>(source: EventTargetLike, type: string, listener: (event: T) => void, options?: unknown) {
    source.addEventListener(type, listener as (event: never) => void, options);
    removers.push(() => source.removeEventListener(type, listener as (event: never) => void, options));
  }
  function position(client: Point) {
    const rect = target.getBoundingClientRect();
    return mapPoint({ x: client.x - rect.left, y: client.y - rect.top }, rect, typeof remote === "function" ? remote() : remote);
  }
  function clientPoint(event: PointerLike) {
    return { x: event.clientX, y: event.clientY };
  }
  function point(event: PointerLike) {
    return position(clientPoint(event));
  }
  function isTouch(event: PointerLike) {
    return event.pointerType === "touch" || event.pointerType === "pen";
  }
  function sendTouch(action: TouchAction | null) {
    if (!action) return;
    const mapped = position(action.point);
    if (!mapped) return;
    if (action.type === "click") send({ type: "click", ...mapped, button: action.button, count: 1 });
    else send({ type: "scroll", ...mapped, dx: action.dx, dy: action.dy });
  }
  function cancelHold() {
    if (touch?.timer !== undefined) clearTimeout(touch.timer);
    if (touch) touch.timer = undefined;
  }
  function releaseTouch() {
    if (!touch) return;
    cancelHold();
    const { pointerId } = touch;
    touch = null;
    try { target.releasePointerCapture(pointerId); } catch { /* Capture may already be lost. */ }
  }
  function setFocus(value: boolean) {
    if (focused === value) return;
    focused = value;
    onFocus(value);
  }
  function flushMove() {
    if (moveTimer !== undefined) clearTimeout(moveTimer);
    moveTimer = undefined;
    if (lastClient) lastPoint = position(lastClient);
    if (!lastPoint || (lastPoint.x === lastSent?.x && lastPoint.y === lastSent?.y)) return;
    send({ type: "move", ...lastPoint });
    lastSent = lastPoint;
    lastMoveAt = Date.now();
  }
  function releaseMouse() {
    if (moveTimer !== undefined) clearTimeout(moveTimer);
    moveTimer = undefined;
    const releases = [...held];
    held.clear();
    if (lastClient) lastPoint = position(lastClient);
    if (lastPoint) {
      for (const [button, pointerId] of releases) {
        send({ type: "up", ...lastPoint, button });
        try { target.releasePointerCapture(pointerId); } catch { /* Capture may already be lost. */ }
      }
    }
  }
  function release() { releaseTouch(); releaseMouse(); }
  function cancelPointer(event: PointerLike) {
    if (isTouch(event) || event.pointerId === touch?.pointerId) {
      if (event.pointerId === touch?.pointerId) releaseTouch();
    } else releaseMouse();
  }

  listen<PointerLike>(target, "pointerdown", (event) => {
    if (isTouch(event)) {
      event.preventDefault();
      if (touch || event.isPrimary === false || !point(event)) return;
      onInteract?.();
      setFocus(true);
      target.focus({ preventScroll: true });
      const gesture = new TouchGesture(clientPoint(event), Date.now());
      touch = {
        pointerId: event.pointerId, gesture,
        timer: setTimeout(() => {
          if (touch?.gesture !== gesture) return;
          touch.timer = undefined;
          sendTouch(gesture.hold(Date.now()));
        }, TOUCH_HOLD_MS),
      };
      try { target.setPointerCapture(event.pointerId); } catch { /* A release outside is also caught below. */ }
      return;
    }
    const position = point(event);
    const button = mouseButton(event.button);
    if (!position || !button) return;
    onInteract?.();
    event.preventDefault();
    setFocus(true);
    target.focus({ preventScroll: true });
    lastPoint = position;
    lastClient = clientPoint(event);
    flushMove();
    held.set(button, event.pointerId);
    try { target.setPointerCapture(event.pointerId); } catch { /* A release outside is also caught below. */ }
    send({ type: "down", ...position, button });
  });
  listen<PointerLike>(target, "pointermove", (event) => {
    if (isTouch(event)) {
      if (touch?.pointerId === event.pointerId) {
        event.preventDefault();
        sendTouch(touch.gesture.move(clientPoint(event)));
        if (touch.gesture.isDragging) cancelHold();
      }
      return;
    }
    const position = point(event);
    if (!position) return;
    lastPoint = position;
    lastClient = clientPoint(event);
    if (Date.now() - lastMoveAt >= 33) flushMove();
    else if (moveTimer === undefined) moveTimer = setTimeout(flushMove, 33 - (Date.now() - lastMoveAt));
    if (held.size) event.preventDefault();
  });
  listen<PointerLike>(window, "pointerup", (event) => {
    if (isTouch(event)) {
      if (touch?.pointerId === event.pointerId) {
        event.preventDefault();
        sendTouch(touch.gesture.end(clientPoint(event), Date.now()));
        releaseTouch();
      }
      return;
    }
    const button = mouseButton(event.button);
    if (!button || !held.has(button)) return;
    lastClient = clientPoint(event);
    lastPoint = point(event) ?? lastPoint;
    flushMove();
    if (lastPoint) send({ type: "up", ...lastPoint, button });
    held.delete(button);
    try { target.releasePointerCapture(event.pointerId); } catch { /* The browser may release it first. */ }
  }, true);
  listen(target, "pointercancel", cancelPointer);
  listen(target, "lostpointercapture", cancelPointer);
  listen(target, "contextmenu", (event: EventLike) => event.preventDefault());
  listen<WheelLike>(target, "wheel", (event) => {
    event.preventDefault();
    const position = point(event);
    if (!position) return;
    const pixels = wheelPixels(event.deltaX, event.deltaY, event.deltaMode, target.getBoundingClientRect().height);
    const notches = wheel.take(pixels.x, pixels.y);
    if (notches.dx || notches.dy) send({ type: "scroll", ...position, ...notches });
  }, { passive: false });
  listen<PointerLike>(document, "pointerdown", (event) => {
    if (isTouch(event) && (event.isPrimary === false || (touch && event.pointerId !== touch.pointerId))) {
      if (touch) event.preventDefault();
      return;
    }
    if (!target.contains(event.target)) {
      release();
      setFocus(false);
    }
  }, true);
  listen<EventLike>(document, "focusin", (event) => {
    if (!target.contains(event.target)) { release(); setFocus(false); }
  }, true);
  listen(window, "blur", () => { release(); setFocus(false); });
  listen<KeyboardLike>(window, "keydown", (event) => {
    if (!focused) return;
    onInteract?.();
    if (isPasteShortcut(event)) {
      event.stopPropagation();
      return;
    }
    if (event.isComposing || ["Dead", "Process", "Unidentified"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const input = keyInput(event);
    if (input) send(input);
  }, true);
  listen<PasteLike>(window, "paste", (event) => {
    if (!focused) return;
    onInteract?.();
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData("text/plain");
    if (text) send({ type: "text", text });
  }, true);
  listen<EventLike & { data?: string }>(window, "compositionend", (event) => {
    if (focused && event.data) { onInteract?.(); send({ type: "text", text: event.data }); }
  }, true);

  return () => {
    release();
    setFocus(false);
    for (const remove of removers) remove();
    Object.assign(target.style, oldStyle);
    if (oldTab === null) target.removeAttribute("tabindex");
    else target.setAttribute("tabindex", oldTab);
  };
}
