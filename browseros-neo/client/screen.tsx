import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import type { RpcInput } from "@getpaseo/plugin";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, PixelRatio, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { fitDisplay, launchBrowser, readFrame, sendInput, type Frame, type InputEvent } from "../shared/contracts.ts";
import { Control } from "./controls.tsx";
import { connectionActive, isReleaseInput, rememberedConnection, rememberConnection } from "./connection.ts";
import { useDisplayFit } from "./display-fit.ts";
import { useFrames } from "./frames.ts";
import { createInputQueue } from "./input-queue.ts";
import { NativeKeyboard } from "./keyboard.tsx";
import type { OptionalText, Size } from "./logic.ts";
import { frameSettings, rememberedQuality, rememberQuality } from "./quality.ts";
import { pinWindow, rememberedWindow, rememberWindow } from "./selection.ts";
import { Viewer } from "./viewer.tsx";
import { useCurrentScreen } from "./viewing.ts";
import { watchShown, type ViewNode } from "./web.ts";

type ReadContract = typeof readFrame;
type FitContract = typeof fitDisplay;
type InputContract = typeof sendInput;
type DisplayedWindow = Pick<Frame, "windowId" | "windowWidth" | "windowHeight">;

export function BrowserScreen(props: PluginScreenProps) {
  return <BrowserScreenBody key={props.host.id} {...props} />;
}

function BrowserScreenBody({ theme, host, layout }: PluginScreenProps) {
  const read = useRpc(readFrame);
  const input = useRpc(sendInput);
  const launch = useRpc(launchBrowser);
  const fit = useRpc(fitDisplay);
  const current = useCurrentScreen(host.id);
  const [connected, setConnected] = useState(() => rememberedConnection(host.id));
  const [root, setRoot] = useState<ViewNode>(null);
  const [drawn, setDrawn] = useState(true);
  const [foreground, setForeground] = useState(Platform.OS === "web" || AppState.currentState === "active");
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [selected, setSelected] = useState<OptionalText>(() => rememberedWindow(host.id));
  const [qualityMode, setQualityMode] = useState(() => rememberedQuality(host.id));
  const [zoom, setZoom] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState<DisplayedWindow | null>(null);
  const [inputError, setInputError] = useState<OptionalText>(null);
  const [launchError, setLaunchError] = useState<OptionalText>(null);
  const [launching, setLaunching] = useState(false);
  const [starting, setStarting] = useState(false);
  const launchInFlight = useRef(false);
  const launchEpoch = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const state = { connected, visible: current && drawn, foreground };
  const permission = useRef(state);
  permission.current = state;
  const active = connectionActive(state);
  const readConnected = useCallback((request: RpcInput<ReadContract>) => {
    if (!connectionActive(permission.current)) return Promise.reject(new Error("BrowserOS is disconnected or paused."));
    return read(request);
  }, [read]);
  const fitConnected = useCallback((request: RpcInput<FitContract>) => {
    if (!connectionActive(permission.current)) return Promise.resolve({ ok: false, width: 0, height: 0, error: null });
    return fit(request);
  }, [fit]);
  const inputConnected = useCallback((request: RpcInput<InputContract>) => {
    if (!connectionActive(permission.current) && !isReleaseInput(request.events)) return Promise.resolve({ ok: true, error: null });
    return input(request);
  }, [input]);
  const { interact, pause: pauseFit } = useDisplayFit(fitConnected, active, box);
  const native = Platform.OS !== "web";
  const touchControls = native || layout.compact;
  const padding = layout.compact ? 8 : 12;
  const queue = useMemo(() => createInputQueue(inputConnected, (message) => {
    if (permission.current.connected) setInputError(message);
  }, false), [inputConnected]);

  useLayoutEffect(() => { queue.activate(); return () => queue.dispose(); }, [queue]);
  useLayoutEffect(() => { if (active) queue.connect(); else queue.disconnect(); }, [queue, active]);
  useEffect(() => watchShown(root, setDrawn), [root]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => { if (!active) setFocused(false); }, [active]);

  const settings = frameSettings({
    qualityMode, compact: layout.compact, native, zoom, box, pixelRatio: PixelRatio.get(),
    shown: shown ? { width: shown.windowWidth, height: shown.windowHeight } : null,
  });
  const { frame, error, getLatestFrame, clear: clearFrames } = useFrames({
    active: active && box.width > 0 && box.height > 0,
    read: readConnected, windowId: selected,
    ...settings,
    refresh,
  });

  useEffect(() => {
    if (frame && frame.status !== "ready") setShown(null);
    if (frame?.status === "ready") {
      setStarting(false);
      setLaunchError(null);
    }
    if (frame) {
      const next = pinWindow(selected, frame);
      if (next !== selected) setSelected(next);
      rememberWindow(host.id, next);
    }
  }, [selected, frame, host.id]);

  const enqueue = useCallback((windowId: string, event: InputEvent) => {
    if (!connectionActive(permission.current)) return;
    setInputError(null);
    queue.push(windowId, event);
  }, [queue]);
  const keyboardInput = useCallback((event: InputEvent) => {
    interact();
    if (shown?.windowId) enqueue(shown.windowId, event);
  }, [shown?.windowId, enqueue, interact]);
  const displayed = useCallback((next: Frame) => {
    if (!permission.current.connected) return;
    setShown((previous) => previous?.windowId === next.windowId && previous.windowWidth === next.windowWidth && previous.windowHeight === next.windowHeight
      ? previous : { windowId: next.windowId, windowWidth: next.windowWidth, windowHeight: next.windowHeight });
  }, []);

  function connect() {
    rememberConnection(host.id, true);
    setConnected(true);
  }

  function disconnect() {
    permission.current = { ...permission.current, connected: false };
    rememberConnection(host.id, false);
    queue.disconnect();
    pauseFit();
    clearFrames();
    launchEpoch.current++;
    launchInFlight.current = false;
    setLaunching(false);
    setStarting(false);
    setLaunchError(null);
    setInputError(null);
    setFocused(false);
    setKeyboard(false);
    setShown(null);
    setConnected(false);
  }

  async function openBrowser() {
    if (!connectionActive(permission.current) || launchInFlight.current || starting) return;
    const epoch = launchEpoch.current;
    launchInFlight.current = true;
    setLaunching(true);
    setStarting(true);
    setLaunchError(null);
    try {
      const result = await launch({});
      if (epoch !== launchEpoch.current || !permission.current.connected) return;
      if (!result.ok) {
        setLaunchError(result.error ?? "BrowserOS could not start.");
        setStarting(false);
      } else setRefresh((value) => value + 1);
    } catch (cause) {
      if (epoch !== launchEpoch.current || !permission.current.connected) return;
      setLaunchError(cause instanceof Error ? cause.message : String(cause));
      setStarting(false);
    } finally {
      if (epoch === launchEpoch.current) {
        launchInFlight.current = false;
        setLaunching(false);
      }
    }
  }

  const live = active && frame?.status === "ready" && shown !== null && !error;
  const ready = connected && frame?.status === "ready";
  const multipleWindows = connected && (frame?.windows.length ?? 0) >= 2;
  const message = connected ? error ?? inputError : null;

  return (
    <View ref={setRoot} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <View style={{ padding, borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <View style={{ height: 34, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: layout.compact ? 6 : 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: live ? theme.colors.statusSuccess : theme.colors.foregroundMuted }} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{!connected ? "Disconnected" : live ? "Live" : active ? "Connecting" : "Paused"}</Text>
          </View>
          {connected ? <Control theme={theme} label="Disconnect" compact={layout.compact} onPress={disconnect} /> : null}
          <Control
            theme={theme} label={layout.compact ? "Quality" : "Quality Mode"} compact={layout.compact}
            role="switch" selected={qualityMode} disabled={!ready}
            accessibilityLabel="Quality Mode" accessibilityHint="Sharper image with more bitrate. Refines to lossless when still."
            onPress={() => {
              const next = !qualityMode;
              rememberQuality(host.id, next);
              setQualityMode(next);
            }}
          />
          {multipleWindows && frame ? (
            <ScrollView horizontal style={{ flex: 1, minWidth: 0, height: 34 }} contentContainerStyle={{ gap: 6, alignItems: "center" }}>
              {frame.windows.map((item) => {
                const chosen = (selected ?? frame.windowId) === item.id;
                return (
                  <Pressable
                    key={item.id} accessibilityRole="button" accessibilityState={{ selected: chosen }}
                    onPress={() => { rememberWindow(host.id, item.id); setSelected(item.id); }}
                    style={{ flexShrink: 0, maxWidth: layout.compact ? 180 : 260, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, backgroundColor: chosen ? theme.colors.accent : theme.colors.surface2 }}
                  >
                    <Text numberOfLines={1} style={{ color: chosen ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{item.title || "Untitled window"}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : <View style={{ flex: 1, minWidth: 0 }} />}
          {native ? <Control theme={theme} label={zoom ? "Fit" : "Zoom"} compact={layout.compact} selected={zoom} disabled={!ready} onPress={() => setZoom((value) => !value)} /> : null}
          {touchControls ? <Control theme={theme} label="Keyboard" compact={layout.compact} selected={keyboard} disabled={!ready} onPress={() => setKeyboard((value) => !value)} /> : null}
        </View>
      </View>
      {message ? (
        <Text selectable style={{ color: theme.colors.statusDanger, paddingHorizontal: padding, paddingVertical: 6, fontSize: 12 }}>{message}</Text>
      ) : null}
      <View
        onLayout={({ nativeEvent: { layout: measured } }) => setBox((previous) =>
          previous.width === measured.width && previous.height === measured.height ? previous : { width: measured.width, height: measured.height })}
        style={{ flex: 1, minHeight: 0, borderWidth: 1, borderColor: focused ? theme.colors.accent : theme.colors.surface0, overflow: "hidden" }}
      >
        {!connected ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: layout.compact ? 20 : 32, gap: 16 }}>
            <Text style={{ color: theme.colors.foreground, textAlign: "center", maxWidth: 480 }}>Not connected to BrowserOS on {host.label}.</Text>
            <Pressable
              accessibilityRole="button" onPress={connect}
              style={({ pressed }) => ({
                minHeight: 52, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 8,
                backgroundColor: theme.colors.accent, opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 16, fontWeight: "600" }}>Connect</Text>
            </Pressable>
          </View>
        ) : ready ? (
          <Viewer
            frame={frame} getLatestFrame={getLatestFrame} box={box} zoom={zoom} active={active} theme={theme}
            onInput={enqueue} onDisplay={displayed} onFocus={setFocused} onInteract={interact}
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: layout.compact ? 20 : 32, gap: 16 }}>
            <Text style={{ color: theme.colors.foreground, textAlign: "center", maxWidth: 480 }}>
              {frame?.reason || (frame?.status === "not-running" ? "BrowserOS is not running on this machine." : frame?.status === "unsupported" ? "BrowserOS cannot be shared from this machine." : "Connecting to BrowserOS…")}
            </Text>
            {frame?.status === "not-running" ? (
              <View style={{ alignItems: "center", gap: 12, maxWidth: 480 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: launching || starting, busy: launching || starting }}
                  disabled={launching || starting}
                  onPress={() => { void openBrowser(); }}
                  style={({ pressed }) => ({
                    minHeight: 52, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 8,
                    backgroundColor: theme.colors.accent, flexDirection: "row", alignItems: "center", gap: 10,
                    opacity: pressed || starting ? 0.8 : 1,
                  })}
                >
                  {starting ? <ActivityIndicator size="small" color={theme.colors.accentForeground} /> : null}
                  <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.accentForeground, fontSize: 16, fontWeight: "600" }}>
                    {starting ? "Starting BrowserOS…" : "Start BrowserOS"}
                  </Text>
                </Pressable>
                {launchError ? <Text selectable style={{ color: theme.colors.statusDanger, textAlign: "center", fontSize: 13 }}>{launchError}</Text> : null}
              </View>
            ) : null}
          </View>
        )}
      </View>
      {!connected ? <View style={{ height: 24 }} /> : touchControls ? (
        keyboard && active && ready && shown?.windowId ? <NativeKeyboard theme={theme} compact={layout.compact} send={keyboardInput} onInteract={interact} /> :
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: padding, paddingVertical: 5 }}>
            {native && zoom ? "Drag to pan. Tap to click. Hold to right click." : "Tap to click. Drag to scroll. Hold to right click."}
          </Text>
      ) : (
        <Text style={{ color: focused ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: padding, paddingVertical: 5 }}>
          {focused ? "Keys go to BrowserOS. Click outside to release." : "Click the browser to control it."}
        </Text>
      )}
    </View>
  );
}
