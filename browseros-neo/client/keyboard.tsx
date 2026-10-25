import type { PluginTheme } from "@getpaseo/plugin";
import { useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import type { InputEvent } from "../shared/contracts.ts";
import { Control } from "./controls.tsx";
import { textChange } from "./logic.ts";

const SENTINEL = "\u200b";
const KEYS = [
  ["Esc", "Escape"], ["Tab", "Tab"], ["Enter", "Enter"], ["⌫", "Backspace"],
  ["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"],
] as const;

export function NativeKeyboard({ theme, compact, send, onInteract }: {
  theme: PluginTheme;
  compact: boolean;
  send(event: InputEvent): void;
  onInteract(): void;
}) {
  const [value, setValue] = useState(SENTINEL);
  const buffer = useRef(SENTINEL);
  const backspacesSent = useRef(0);

  function changed(next: string) {
    const change = textChange(buffer.current, next);
    for (let index = backspacesSent.current; index < change.removed; index++) {
      send({ type: "key", key: "Backspace", modifiers: [] });
    }
    backspacesSent.current = 0;
    const inserted = change.inserted.replaceAll(SENTINEL, "");
    if (inserted) send({ type: "text", text: inserted });
    const kept = next.length > 64 || !next ? SENTINEL : next;
    buffer.current = kept;
    setValue(kept);
  }

  return (
    <View onTouchStart={onInteract} style={{ padding: compact ? 8 : 12, gap: 8, borderTopWidth: 1, borderColor: theme.colors.border }}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6 }}>
        <Control theme={theme} label="Address bar" onPress={() => send({ type: "key", key: "l", modifiers: ["ctrl"] })} />
        {KEYS.map(([label, key]) => (
          <Control key={key} theme={theme} label={label} onPress={() => send({ type: "key", key, modifiers: [] })} />
        ))}
      </ScrollView>
      <TextInput
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        accessibilityLabel="Type into BrowserOS"
        placeholder="Type into BrowserOS…"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={value}
        onChangeText={changed}
        onKeyPress={({ nativeEvent }) => {
          onInteract();
          if (nativeEvent.key === "Backspace") {
            backspacesSent.current++;
            send({ type: "key", key: "Backspace", modifiers: [] });
          }
        }}
        onSubmitEditing={() => send({ type: "key", key: "Enter", modifiers: [] })}
        submitBehavior="submit"
        style={{
          minHeight: 42, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
          backgroundColor: theme.colors.surface2, color: theme.colors.foreground,
          borderWidth: 1, borderColor: theme.colors.border,
        }}
      />
    </View>
  );
}
