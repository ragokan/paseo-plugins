import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text } from "react-native";

export function Control({ theme, label, onPress, selected = false, disabled = false, role = "button", compact = false, accessibilityLabel, accessibilityHint }: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  selected?: boolean;
  disabled?: boolean;
  role?: "button" | "switch";
  compact?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={role === "switch" ? { checked: selected, disabled } : { selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: compact ? 8 : 12, paddingVertical: 9, borderRadius: 6,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}
