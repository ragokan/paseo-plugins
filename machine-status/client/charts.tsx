import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { columnHeights, padSlots, paletteFor, severityOf, stackedColumn, type VizPalette } from "../shared/viz.ts";
import { useChromeStyles, type Chrome } from "./ui.tsx";

/**
 * React Native has no SVG and Paseo's client bundle cannot import one, so every
 * chart here is built from Views. A line becomes a column per sample, which is a
 * legitimate reading of the same series rather than a downgrade: each sample stays
 * individually visible instead of being interpolated into a curve.
 */

const BASELINE_RADIUS = 2;

export function Sparkbars({
  values,
  min,
  max,
  color,
  slots,
  height = 34,
}: {
  values: readonly number[];
  min: number;
  max: number;
  color: string;
  slots: number;
  height?: number;
}) {
  const cells = useMemo(
    () => padSlots(columnHeights(values, min, max), slots),
    [values, min, max, slots],
  );
  return (
    <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap: 1 }}>
      {cells.map((value, index) =>
        value === null ? (
          <View key={index} style={{ flex: 1 }} />
        ) : (
          <View
            key={index}
            style={{
              flex: 1,
              height: `${Math.max(value, 2)}%`,
              backgroundColor: color,
              borderTopLeftRadius: BASELINE_RADIUS,
              borderTopRightRadius: BASELINE_RADIUS,
            }}
          />
        ),
      )}
    </View>
  );
}

function Gridlines({ color }: { color: string }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {[0, 50, 100].map((position) => (
        <View
          key={position}
          style={{
            position: "absolute",
            top: `${position}%`,
            left: 0,
            right: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

/** Axis captions sit outside the plot; the grid stays recessive behind the marks. */
export function ColumnChart({
  chrome,
  values,
  min,
  max,
  color,
  palette,
  slots,
  height = 140,
  topLabel,
  midLabel,
  bottomLabel,
  caption,
}: {
  chrome: Chrome;
  values: readonly number[];
  min: number;
  max: number;
  color: string;
  palette: VizPalette;
  slots: number;
  height?: number;
  topLabel: string;
  midLabel: string;
  bottomLabel: string;
  caption?: string;
}) {
  const styles = useChromeStyles(chrome);
  const cells = useMemo(
    () => padSlots(columnHeights(values, min, max), slots),
    [values, min, max, slots],
  );

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ height, justifyContent: "space-between", alignItems: "flex-end", width: 34 }}>
          <Text style={styles.axis}>{topLabel}</Text>
          <Text style={styles.axis}>{midLabel}</Text>
          <Text style={styles.axis}>{bottomLabel}</Text>
        </View>
        <View style={{ flex: 1, height }}>
          <Gridlines color={palette.grid} />
          <View
            style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 1 }}
          >
            {cells.map((value, index) =>
              value === null ? (
                <View key={index} style={{ flex: 1 }} />
              ) : (
                <View
                  key={index}
                  style={{
                    flex: 1,
                    height: `${Math.max(value, 2)}%`,
                    backgroundColor: color,
                    borderTopLeftRadius: BASELINE_RADIUS,
                    borderTopRightRadius: BASELINE_RADIUS,
                  }}
                />
              ),
            )}
          </View>
        </View>
      </View>
      {caption ? <Text style={[styles.axis, { paddingLeft: 42 }]}>{caption}</Text> : null}
    </View>
  );
}

/**
 * Stacked columns for a part-to-whole series over time. Segments carry a 2px
 * surface gap so adjacent fills stay separable without relying on hue alone.
 */
export function StackedColumnChart({
  chrome,
  columns,
  colors,
  palette,
  slots,
  height = 140,
  topLabel,
  midLabel,
  bottomLabel,
  caption,
}: {
  chrome: Chrome;
  /** Each entry is one column's parts, plus the total they are measured against. */
  columns: readonly { parts: readonly number[]; total: number }[];
  colors: readonly string[];
  palette: VizPalette;
  slots: number;
  height?: number;
  topLabel: string;
  midLabel: string;
  bottomLabel: string;
  caption?: string;
}) {
  const styles = useChromeStyles(chrome);
  const stacks = useMemo(
    () => padSlots(columns.map((column) => stackedColumn(column.parts, column.total)), slots),
    [columns, slots],
  );

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ height, justifyContent: "space-between", alignItems: "flex-end", width: 34 }}>
          <Text style={styles.axis}>{topLabel}</Text>
          <Text style={styles.axis}>{midLabel}</Text>
          <Text style={styles.axis}>{bottomLabel}</Text>
        </View>
        <View style={{ flex: 1, height }}>
          <Gridlines color={palette.grid} />
          <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
            {stacks.map((segments, index) =>
              segments === null ? (
                <View key={index} style={{ flex: 1 }} />
              ) : (
              <View
                key={index}
                style={{ flex: 1, height: "100%", flexDirection: "column-reverse" }}
              >
                {segments.map((segment, part) => {
                  const fill = colors[part];
                  // The last segment is the unused remainder: it reads as headroom,
                  // so it stays empty rather than becoming a grey category block.
                  if (!fill) return <View key={part} style={{ height: `${segment}%` }} />;
                  return (
                    <View
                      key={part}
                      style={{
                        height: `${segment}%`,
                        backgroundColor: fill,
                        borderTopWidth: part > 0 ? 2 : 0,
                        borderTopColor: chrome.theme.colors.surface0,
                      }}
                    />
                  );
                })}
              </View>
              ),
            )}
          </View>
        </View>
      </View>
      {caption ? <Text style={[styles.axis, { paddingLeft: 42 }]}>{caption}</Text> : null}
    </View>
  );
}

/** Core numbers fit under the bars up to this many cores; beyond it only the ends are labelled. */
const LABELLED_CORES = 32;

/**
 * One column per core, filled from the bottom like btop's core bars, coloured by
 * the same thresholds as the CPU tile. Columns rather than rows, so 4 cores and
 * 64 take the same height.
 */
export function CoreBars({
  chrome,
  cores,
  palette,
  height = 56,
}: {
  chrome: Chrome;
  cores: readonly { id: number; busyPercent: number }[];
  palette: VizPalette;
  height?: number;
}) {
  const styles = useChromeStyles(chrome);
  if (cores.length === 0) return null;
  const labelled = cores.length <= LABELLED_CORES;
  return (
    <View
      style={{ gap: 4 }}
      accessible
      accessibilityLabel={`Per core: ${cores.map((core) => `core ${core.id} ${Math.round(core.busyPercent)}%`).join(", ")}`}
    >
      <View style={{ height, flexDirection: "row", gap: cores.length > LABELLED_CORES ? 1 : 3 }}>
        {cores.map((core) => {
          const severity = severityOf(core.busyPercent);
          return (
            <View
              key={core.id}
              style={{ flex: 1, justifyContent: "flex-end", backgroundColor: palette.neutral, borderRadius: 2, overflow: "hidden" }}
            >
              <View
                style={{
                  height: `${Math.max(0, Math.min(100, core.busyPercent))}%`,
                  backgroundColor: severity === "good" ? palette.series[0] : palette.status[severity],
                }}
              />
            </View>
          );
        })}
      </View>
      {labelled ? (
        <View style={{ flexDirection: "row", gap: 3 }}>
          {cores.map((core) => (
            <Text key={core.id} style={[styles.axis, { flex: 1, textAlign: "center" }]} numberOfLines={1}>
              {core.id}
            </Text>
          ))}
        </View>
      ) : (
        <View style={styles.row}>
          <Text style={styles.axis}>{cores[0].id}</Text>
          <Text style={styles.axis}>{cores[cores.length - 1].id}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * A single ratio against a limit. This replaces the donut the design used: a ring
 * encodes one number worse than a track does, and it cannot be drawn without SVG.
 */
export function Meter({
  percent,
  color,
  palette,
  height = 8,
}: {
  percent: number;
  color: string;
  palette: VizPalette;
  height?: number;
}) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: palette.neutral,
        overflow: "hidden",
      }}
    >
      <View style={{ width: `${width}%`, height: "100%", borderRadius: height / 2, backgroundColor: color }} />
    </View>
  );
}

/** Identity never rests on colour alone: every swatch ships with its label and value. */
export function Legend({
  chrome,
  items,
}: {
  chrome: Chrome;
  items: readonly { label: string; value: string; color: string }[];
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={styles.rowWrap}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: item.color }} />
          <Text style={styles.muted}>{item.label}</Text>
          <Text style={styles.value}>{item.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function StatTile({
  chrome,
  label,
  labelColor,
  meta,
  value,
  valueSuffix,
  valueColor,
  expanded,
  onPress,
  children,
  footer,
}: {
  chrome: Chrome;
  label: string;
  labelColor: string;
  meta: string;
  value: string;
  valueSuffix: string;
  valueColor?: string;
  expanded: boolean;
  onPress: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const styles = useChromeStyles(chrome);
  const palette = paletteFor(chrome.theme.colors.surface0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${label}, ${value} ${valueSuffix}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          flexGrow: 1,
          flexBasis: chrome.compact ? "100%" : 200,
          borderColor: expanded ? chrome.theme.colors.accent : palette.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.cardTitle, { color: labelColor }]}>{label}</Text>
        <Text style={styles.axis}>{meta}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={[styles.figure, valueColor ? { color: valueColor } : null]}>{value}</Text>
        <Text style={styles.muted}>{valueSuffix}</Text>
      </View>
      {children}
      {footer}
    </Pressable>
  );
}
