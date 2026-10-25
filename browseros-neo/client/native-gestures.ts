import { useEffect, useMemo, useRef } from "react";
import { PanResponder, type GestureResponderEvent } from "react-native";
import type { InputEvent } from "../shared/contracts.ts";
import { mapPoint, NotchAccumulator, type Point, type Size, type Timer } from "./logic.ts";

interface Options {
  active: boolean;
  drawn: Size;
  remote: Size;
  send(event: InputEvent): void;
  onInteract(): void;
}

export function touchPoint(event: GestureResponderEvent, drawn: Size, remote: Size) {
  return mapPoint({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, drawn, remote);
}

export function useNativeGestures(options: Options) {
  const current = useRef(options);
  current.current = options;
  const timer = useRef<Timer | undefined>(undefined);
  const cancelLongPress = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => {
    if (!options.active) cancelLongPress();
    return cancelLongPress;
  }, [options.active]);

  return useMemo(() => {
    let start: Point | null = null;
    let origin: Options | null = null;
    let moved = false;
    let longPressed = false;
    let last = { x: 0, y: 0 };
    let scroll = new NotchAccumulator();
    return PanResponder.create({
      onStartShouldSetPanResponder: () => current.current.active,
      onMoveShouldSetPanResponder: () => current.current.active,
      onPanResponderGrant(event) {
        const { drawn, remote, active } = current.current;
        if (!active) return;
        current.current.onInteract();
        cancelLongPress();
        origin = current.current;
        start = touchPoint(event, drawn, remote);
        moved = false;
        longPressed = false;
        last = { x: 0, y: 0 };
        scroll = new NotchAccumulator();
        timer.current = setTimeout(() => {
          timer.current = undefined;
          const next = current.current;
          if (start && next.active && origin?.send === next.send && !moved) {
            longPressed = true;
            if (origin.remote.width !== next.remote.width || origin.remote.height !== next.remote.height ||
                origin.drawn.width !== next.drawn.width || origin.drawn.height !== next.drawn.height) return;
            current.current.send({ type: "click", ...start, button: "right", count: 1 });
          }
        }, 500);
      },
      onPanResponderMove(event, gesture) {
        const next = current.current;
        if (!next.active || !start || origin?.send !== next.send || longPressed) return;
        if (!moved && Math.hypot(gesture.dx, gesture.dy) < 7) return;
        moved = true;
        cancelLongPress();
        const notches = scroll.take(last.x - gesture.dx, last.y - gesture.dy, 40);
        last = { x: gesture.dx, y: gesture.dy };
        const point = touchPoint(event, next.drawn, next.remote);
        if (point && (notches.dx || notches.dy)) next.send({ type: "scroll", ...point, ...notches });
      },
      onPanResponderRelease(event) {
        cancelLongPress();
        const next = current.current;
        if (start && next.active && origin?.send === next.send && !moved && !longPressed) {
          const point = touchPoint(event, next.drawn, next.remote);
          if (point) next.send({ type: "click", ...point, button: "left", count: 1 });
        }
        start = null;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate() { cancelLongPress(); start = null; },
      onShouldBlockNativeResponder: () => true,
    }).panHandlers;
  }, []);
}
