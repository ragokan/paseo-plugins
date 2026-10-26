import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PixelRatio, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { Frame, InputEvent } from "../shared/contracts.ts";
import { bufferedFrame, decodedFrame, frameKey, sameFramePixels } from "./frame-buffer.ts";
import { FrameImage } from "./frame-image.tsx";
import { fitSize, type OptionalText, type Size } from "./logic.ts";
import { touchPoint, useNativeGestures } from "./native-gestures.ts";
import { bindViewer, type ViewNode } from "./web.ts";

interface Props {
  frame: Frame;
  getLatestFrame(): Frame | null;
  box: Size;
  zoom: boolean;
  active: boolean;
  theme: PluginTheme;
  onInput(windowId: string, event: InputEvent): void;
  onDisplay(frame: Frame): void;
  onFocus(focused: boolean): void;
  onInteract(): void;
}

export function Viewer({ frame, getLatestFrame, box, zoom, active, theme, onInput, onDisplay, onFocus, onInteract }: Props) {
  const [slots, setSlots] = useState<[Frame | null, Frame | null]>([null, null]);
  const [front, setFront] = useState<0 | 1 | null>(null);
  const [loading, setLoading] = useState<0 | 1 | null>(null);
  const [failed, setFailed] = useState<OptionalText>(null);
  const [node, setNode] = useState<ViewNode>(null);
  const shown = front === null ? null : slots[front];
  const shownId = shown?.windowId ?? null;
  const width = shown?.windowWidth ?? frame.windowWidth;
  const height = shown?.windowHeight ?? frame.windowHeight;
  const remote = { width, height };
  const zoomed = zoom && Platform.OS !== "web";
  const fitted = fitSize(box, remote, zoomed);
  const scale = zoomed
    ? Math.max(2, width / PixelRatio.get() / Math.max(1, fitted.width))
    : 1;
  const drawn = { width: fitted.width * scale, height: fitted.height * scale };
  const callbacks = useRef({ onDisplay, onFocus, onInteract, getLatestFrame });
  callbacks.current = { onDisplay, onFocus, onInteract, getLatestFrame };
  const geometry = useRef(remote);
  const pending = useRef<Frame | null>(null);
  const decoded = useRef<[Frame | null, Frame | null]>([null, null]);
  const zoomOrigin = useRef<{ windowId: string | null; drawn: Size; remote: Size } | null>(null);
  useLayoutEffect(() => { geometry.current = { width, height }; }, [width, height]);
  const interact = useCallback(() => callbacks.current.onInteract(), []);

  useEffect(() => {
    const latest = callbacks.current.getLatestFrame();
    const next = latest && bufferedFrame(latest, slots);
    if (!next) return;
    if (shown && sameFramePixels(shown, next)) {
      if (front !== null && (next.windowWidth !== shown.windowWidth || next.windowHeight !== shown.windowHeight)) {
        setSlots((previous) => {
          const updated: [Frame | null, Frame | null] = [...previous];
          updated[front] = next;
          return updated;
        });
        callbacks.current.onDisplay(next);
      }
      return;
    }
    if (loading !== null || failed === frameKey(next)) return;
    const back = front === 0 ? 1 : 0;
    const reusable = sameFramePixels(decoded.current[back], next);
    if (!reusable) decoded.current[back] = null;
    pending.current = reusable ? null : next;
    setSlots((previous) => {
      const updated: [Frame | null, Frame | null] = [...previous];
      updated[back] = next;
      return updated;
    });
    if (reusable) {
      setFront(back);
      callbacks.current.onDisplay(next);
    } else setLoading(back);
  }, [frame, slots, loading, front, shown, failed]);

  useEffect(() => {
    if (failed === null) return;
    const timer = setTimeout(() => setFailed(null), 1500);
    return () => clearTimeout(timer);
  }, [failed]);

  const send = useCallback((event: InputEvent) => {
    if (shownId) onInput(shownId, event);
  }, [shownId, onInput]);
  useLayoutEffect(() => {
    if (!active || !shownId) return;
    return bindViewer(node, {
      remote: () => geometry.current, send, onInteract: interact,
      onFocus: (focused) => callbacks.current.onFocus(focused),
    });
  }, [node, active, shownId, send, interact]);

  const gestures = useNativeGestures({
    active: active && Boolean(shownId) && !zoom && Platform.OS !== "web",
    drawn, remote, send, onInteract: interact,
  });

  const loaded = useCallback((slot: Frame, index: number) => {
    if (pending.current !== slot) return;
    decoded.current[index] = slot;
    pending.current = null;
    setLoading(null);
    const next = decodedFrame(callbacks.current.getLatestFrame(), slot);
    if (!next) return;
    if (next !== slot) setSlots((previous) => {
      const updated: [Frame | null, Frame | null] = [...previous];
      updated[index] = next;
      return updated;
    });
    setFront(index as 0 | 1);
    setFailed(null);
    callbacks.current.onDisplay(next);
  }, []);
  const imageFailed = useCallback((slot: Frame) => {
    if (pending.current !== slot) return;
    pending.current = null;
    if (sameFramePixels(callbacks.current.getLatestFrame(), slot)) setFailed(frameKey(slot));
    setLoading(null);
  }, []);

  function images() {
    return slots.map((slot, index) => slot?.image ? (
      <View
        key={`${index}:${frameKey(slot)}`}
        pointerEvents="none"
        style={{ position: "absolute", left: 0, top: 0, width: drawn.width, height: drawn.height, zIndex: index === front ? 1 : 0, opacity: front === null ? 0 : 1 }}
      >
        <FrameImage frame={slot} index={index} width={drawn.width} height={drawn.height} onLoad={loaded} onError={imageFailed} />
      </View>
    ) : null);
  }

  const surface = Platform.OS !== "web" && zoom ? (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="BrowserOS: tap to click, hold to right click, drag to pan."
      disabled={!active || !shownId}
      delayLongPress={500}
      onPressIn={() => { zoomOrigin.current = { windowId: shownId, drawn, remote }; interact(); }}
      onPress={(event) => {
        if (zoomOrigin.current?.windowId !== shownId) return;
        const point = touchPoint(event, drawn, remote);
        if (point) send({ type: "click", ...point, button: "left", count: 1 });
      }}
      onLongPress={(event) => {
        const origin = zoomOrigin.current;
        if (origin?.windowId !== shownId || origin.remote.width !== width || origin.remote.height !== height ||
            origin.drawn.width !== drawn.width || origin.drawn.height !== drawn.height) return;
        const point = touchPoint(event, drawn, remote);
        if (point) send({ type: "click", ...point, button: "right", count: 1 });
      }}
      style={{ width: drawn.width, height: drawn.height }}
    >
      {images()}
    </Pressable>
  ) : (
    <View
      ref={setNode}
      {...(Platform.OS === "web" ? {} : gestures)}
      accessibilityLabel="BrowserOS window"
      style={{ width: drawn.width, height: drawn.height }}
    >
      {images()}
    </View>
  );

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      {zoom && Platform.OS !== "web" ? (
        <ScrollView horizontal nestedScrollEnabled bounces={false} contentContainerStyle={{ minWidth: box.width }}>
          <ScrollView
            nestedScrollEnabled bounces={false}
            style={{ width: Math.max(box.width, drawn.width), height: box.height }}
            contentContainerStyle={{ minHeight: box.height, alignItems: "center", justifyContent: "center" }}
          >
            {surface}
          </ScrollView>
        </ScrollView>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>{surface}</View>
      )}
      {!shown || failed ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: theme.colors.foregroundMuted, backgroundColor: theme.colors.surface0, padding: 12 }}>
            {failed ? "Could not display the frame. Retrying…" : "Loading frame…"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
