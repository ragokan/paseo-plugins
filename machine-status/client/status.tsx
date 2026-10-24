import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ColumnChart, CoreBars, Legend, Meter, Sparkbars, StackedColumnChart, StatTile } from "./charts.tsx";
import { ServicesTab } from "./services.tsx";
import { DockerTab } from "./docker.tsx";
import type { MachineScreenProps } from "./compat.tsx";
import { ContextMenuProvider } from "./menu.tsx";
import { useCurrentScreen } from "./viewing.ts";
import { watchShown } from "./web.ts";
import { readMetrics, type Metrics } from "../shared/contracts.ts";
import { formatBytes, formatDuration, formatMinutes, formatPercent } from "../shared/format.ts";
import { ProcessesSection } from "./processes.tsx";
import { ActionButton, Card, MetricRow, useChromeStyles, type Chrome } from "./ui.tsx";
import {
  cpuSeverity as cpuSeverityOf,
  memorySeverity as memorySeverityOf,
  paletteFor,
  SEVERITY_LABEL,
  severityOf,
  spanLabel,
} from "../shared/viz.ts";

type Expanded = "cpu" | "memory" | "swap" | "disk" | null;

const THERMAL_LABEL: Record<string, string> = {
  nominal: "Nominal",
  fair: "Fair",
  serious: "Serious",
  critical: "Critical",
  unknown: "Not reported",
};

const GB = 1024 ** 3;

type MemoryKey = "appBytes" | "sharedBytes" | "kernelBytes" | "compressedBytes";

/**
 * The memory in use the chart stacks, as each system splits it. macOS has no
 * tmpfs to speak of; its compressed memory takes that slot, and its wired
 * memory the kernel's.
 */
const MEMORY_PARTS: Record<Metrics["os"], readonly { label: string; detail: string; key: MemoryKey }[]> = {
  linux: [
    { label: "Apps", detail: "Apps", key: "appBytes" },
    { label: "Shared", detail: "Shared and tmpfs", key: "sharedBytes" },
    { label: "Kernel", detail: "Kernel", key: "kernelBytes" },
  ],
  macos: [
    { label: "Apps", detail: "Apps", key: "appBytes" },
    { label: "Compressed", detail: "Compressed", key: "compressedBytes" },
    { label: "Wired", detail: "Wired", key: "kernelBytes" },
  ],
};

const PRESSURE_LABEL: Record<NonNullable<Metrics["memory"]["pressure"]>, string> = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
};

function OverviewTab({ theme, layout, host, live }: PluginSurfaceProps & { live: boolean }) {
  const chrome: Chrome = { theme, compact: layout.compact };
  const styles = useChromeStyles(chrome);
  const palette = useMemo(() => paletteFor(theme.colors.surface0), [theme.colors.surface0]);

  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const toggle = (key: Exclude<Expanded, null>) =>
    setExpanded((current) => (current === key ? null : key));

  const read = useRpc(readMetrics);
  const metrics = useQuery({
    queryKey: ["machine-status", "metrics", host.id],
    queryFn: () => read({}),
    enabled: live,
    refetchInterval: paused || !live ? false : 3_000,
  });
  const data = metrics.data;
  const history = data?.history ?? [];
  const mac = data?.os === "macos";
  const parts = MEMORY_PARTS[data?.os ?? "linux"];

  // Fixed plot widths: the chart occupies the whole card and fills from the right.
  const sparkSlots = layout.compact ? 20 : 40;
  const chartSlots = layout.compact ? 45 : 90;
  const stackSlots = layout.compact ? 24 : 45;
  const span = spanLabel(history[0]?.at, history[history.length - 1]?.at);

  const cpuSeries = useMemo(() => history.map((sample) => sample.cpuPercent), [history]);
  const memorySeries = useMemo(() => history.map((sample) => sample.memoryPercent), [history]);
  const swapSeries = useMemo(
    () => history.map((sample) => sample.swapUsedBytes / GB),
    [history],
  );
  const memColumns = useMemo(
    () =>
      history.map((sample) => ({
        parts: parts.map((part) => sample[part.key]),
        total: data?.memory.totalBytes ?? 1,
      })),
    [history, parts, data?.memory.totalBytes],
  );

  const cpuSeverity = cpuSeverityOf(data?.cpu.busyPercent ?? null);
  const memorySeverity = memorySeverityOf(data?.memory.usedPercent ?? null);
  const diskSeverity = severityOf(data?.disk.usedPercent ?? null, 85, 95);
  const hasSwap = (data?.swap.totalBytes ?? 0) > 0;
  const swapPercent = data && hasSwap ? (data.swap.usedBytes / data.swap.totalBytes) * 100 : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={styles.heading}>{data?.hostname ?? host.label}</Text>
          <Text style={styles.muted}>
            {data
              ? `${data.platform} · up ${formatDuration(data.uptimeSeconds)}`
              : "Reading metrics…"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <Text style={styles.axis}>
            {paused ? "Paused" : `Live · every 3s · ${span}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={paused ? "Resume sampling" : "Pause sampling"}
            onPress={() => setPaused((value) => !value)}
            style={({ pressed }) => [styles.chip, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.value}>{paused ? "Resume" : "Pause"}</Text>
          </Pressable>
        </View>
      </View>

      {metrics.error ? (
        <Card chrome={chrome} title="Metrics unavailable">
          <Text style={styles.danger}>{(metrics.error as Error).message}</Text>
        </Card>
      ) : null}

      {data ? (
        <>
          <View style={styles.tiles}>
            <StatTile
              chrome={chrome}
              label="CPU"
              labelColor={palette.series[0]}
              meta={`${data.cpu.cores} cores`}
              value={formatPercent(data.cpu.busyPercent)}
              valueSuffix="busy"
              valueColor={cpuSeverity === "good" ? undefined : palette.status[cpuSeverity]}
              expanded={expanded === "cpu"}
              onPress={() => toggle("cpu")}
              footer={
                <Text style={styles.muted}>
                  load {data.cpu.loadAvg1.toFixed(2)} · {data.cpu.loadAvg5.toFixed(2)} ·{" "}
                  {data.cpu.loadAvg15.toFixed(2)} · {SEVERITY_LABEL[cpuSeverity]}
                </Text>
              }
            >
              <Sparkbars
                values={cpuSeries}
                min={0}
                max={100}
                slots={sparkSlots}
                color={palette.series[0]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="MEMORY"
              labelColor={palette.series[1]}
              meta={formatBytes(data.memory.totalBytes)}
              value={formatPercent(data.memory.usedPercent)}
              valueSuffix="in use"
              valueColor={memorySeverity === "good" ? undefined : palette.status[memorySeverity]}
              expanded={expanded === "memory"}
              onPress={() => toggle("memory")}
              footer={
                <Text style={styles.muted}>
                  {formatBytes(data.memory.availableBytes)} available · {SEVERITY_LABEL[memorySeverity]}
                </Text>
              }
            >
              <Sparkbars
                values={memorySeries}
                min={0}
                max={100}
                slots={sparkSlots}
                color={palette.series[1]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="SWAP"
              labelColor={palette.series[2]}
              meta={hasSwap ? formatBytes(data.swap.totalBytes) : ""}
              value={hasSwap ? formatBytes(data.swap.usedBytes) : mac ? "None" : "Off"}
              valueSuffix={hasSwap ? "in use" : ""}
              expanded={expanded === "swap"}
              onPress={() => toggle("swap")}
              footer={
                <Text style={styles.muted}>
                  {hasSwap
                    ? `${formatBytes(data.swap.freeBytes)} free`
                    : mac
                      ? "macOS adds swap when it needs it"
                      : "No swap configured"}
                </Text>
              }
            >
              <Sparkbars
                values={swapSeries}
                min={0}
                max={Math.max(data.swap.totalBytes / GB, 0.1)}
                slots={sparkSlots}
                color={palette.series[2]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="DISK"
              labelColor={palette.series[3]}
              meta={data.disk.mountedOn}
              value={formatPercent(data.disk.usedPercent)}
              valueSuffix="used"
              valueColor={diskSeverity === "good" ? undefined : palette.status[diskSeverity]}
              expanded={expanded === "disk"}
              onPress={() => toggle("disk")}
              footer={<Text style={styles.muted}>{formatBytes(data.disk.freeBytes)} free</Text>}
            >
              <View style={{ height: 34, justifyContent: "center" }}>
                <Meter
                  percent={data.disk.usedPercent}
                  color={diskSeverity === "good" ? palette.series[3] : palette.status[diskSeverity]}
                  palette={palette}
                />
              </View>
            </StatTile>
          </View>

          {expanded === "cpu" ? (
            <DetailCard chrome={chrome} title="CPU · detail" onClose={() => setExpanded(null)}>
              <MetricRow
                chrome={chrome}
                label="Busy"
                value={`${formatPercent(data.cpu.busyPercent)} · ${SEVERITY_LABEL[cpuSeverity]}`}
              />
              <MetricRow chrome={chrome} label="User" value={formatPercent(data.cpu.userPercent)} />
              <MetricRow chrome={chrome} label="System" value={formatPercent(data.cpu.systemPercent)} />
              {mac ? null : (
                <>
                  <MetricRow chrome={chrome} label="Steal" value={formatPercent(data.cpu.stealPercent)} />
                  <MetricRow chrome={chrome} label="I/O wait" value={formatPercent(data.cpu.iowaitPercent)} />
                </>
              )}
              <MetricRow chrome={chrome} label="Load 1 min" value={data.cpu.loadAvg1.toFixed(2)} />
              <MetricRow chrome={chrome} label="Load 5 min" value={data.cpu.loadAvg5.toFixed(2)} />
              <MetricRow chrome={chrome} label="Load 15 min" value={data.cpu.loadAvg15.toFixed(2)} />
              <MetricRow chrome={chrome} label="Load per core" value={formatPercent(data.cpu.loadPercent)} />
              {mac ? null : (
                <MetricRow chrome={chrome} label="Waiting for CPU, 10 s" value={formatPercent(data.cpu.stallPercent)} />
              )}
              <Text style={styles.muted}>
                {mac
                  ? "Busy is user plus system time. Load counts the threads running or waiting to run, so 100% per core means every core has one."
                  : "Busy is user plus system plus steal. Steal is time the cloud host gave to other guests; I/O wait is idle time spent waiting on disk. Linux load also counts tasks waiting on disk, so it can sit above 100% per core while the CPU is idle."}
              </Text>
            </DetailCard>
          ) : null}

          {expanded === "memory" ? (
            <DetailCard chrome={chrome} title="Memory · detail" onClose={() => setExpanded(null)}>
              {[
                ...parts.map((part, index) => ({ label: part.detail, bytes: data.memory[part.key], color: palette.series[index] })),
                { label: mac ? "Cached files" : "Reclaimable cache", bytes: data.memory.cachedBytes, color: palette.neutral },
              ].map((row) => (
                <View key={row.label} style={{ gap: 4 }}>
                  <View style={styles.row}>
                    <Text style={styles.muted}>{row.label}</Text>
                    <Text style={styles.value}>{formatBytes(row.bytes)}</Text>
                  </View>
                  <Meter
                    percent={(row.bytes / data.memory.totalBytes) * 100}
                    color={row.color}
                    palette={palette}
                    height={6}
                  />
                </View>
              ))}
              <MetricRow chrome={chrome} label="Available" value={formatBytes(data.memory.availableBytes)} />
              {mac ? (
                <MetricRow
                  chrome={chrome}
                  label="Memory pressure"
                  value={data.memory.pressure === null ? "Not reported" : PRESSURE_LABEL[data.memory.pressure]}
                />
              ) : (
                <MetricRow
                  chrome={chrome}
                  label="Waiting for memory, 10 s"
                  value={formatPercent(data.memory.stallPercent)}
                />
              )}
              <Text style={styles.muted}>
                {mac
                  ? "In use is app, wired and compressed memory, as Activity Monitor counts it. Wired memory cannot be compressed or paged out; cached files go when apps need the room."
                  : "In use is total minus what the kernel calls available. Shared memory and tmpfs files count as cache in `free`, but they stay in RAM until deleted."}
              </Text>
            </DetailCard>
          ) : null}

          {expanded === "swap" ? (
            <DetailCard chrome={chrome} title="Swap · detail" onClose={() => setExpanded(null)}>
              <ColumnChart
                chrome={chrome}
                values={swapSeries}
                min={0}
                max={Math.max(data.swap.totalBytes / GB, 0.1)}
                color={palette.series[2]}
                palette={palette}
                slots={chartSlots}
                height={110}
                topLabel={`${(data.swap.totalBytes / GB).toFixed(1)}G`}
                midLabel={`${(data.swap.totalBytes / GB / 2).toFixed(1)}G`}
                bottomLabel="0"
                caption={span}
              />
              <MetricRow chrome={chrome} label="In use" value={formatBytes(data.swap.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.swap.freeBytes)} />
            </DetailCard>
          ) : null}

          {expanded === "disk" ? (
            <DetailCard chrome={chrome} title="Disk · detail" onClose={() => setExpanded(null)}>
              <Meter
                percent={data.disk.usedPercent}
                color={diskSeverity === "good" ? palette.series[3] : palette.status[diskSeverity]}
                palette={palette}
                height={12}
              />
              <MetricRow chrome={chrome} label="Volume" value={data.disk.mountedOn} />
              <MetricRow chrome={chrome} label="Used" value={formatBytes(data.disk.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.disk.freeBytes)} />
            </DetailCard>
          ) : null}

          {/* The design pairs the two time charts on one band, 1.15fr : 1fr. */}
          <View style={styles.band}>
            <View style={{ flex: 1.15 }}>
              <Card
                chrome={chrome}
                title="CPU over time"
                subtitle={`${formatPercent(data.cpu.busyPercent)} busy · ${SEVERITY_LABEL[cpuSeverity]}`}
              >
                <ColumnChart
                  chrome={chrome}
                  values={cpuSeries}
                  min={0}
                  max={100}
                  color={palette.series[0]}
                  palette={palette}
                  slots={chartSlots}
                  height={layout.compact ? 110 : 180}
                  topLabel="100%"
                  midLabel="50%"
                  bottomLabel="0%"
                  caption={span}
                />
                {data.cpu.perCore.length > 0 ? (
                  <>
                    <View style={styles.row}>
                      <Text style={styles.muted}>Per core</Text>
                      <Text style={styles.muted}>
                        busiest {formatPercent(Math.max(...data.cpu.perCore.map((core) => core.busyPercent)))}
                      </Text>
                    </View>
                    <CoreBars
                      chrome={chrome}
                      cores={data.cpu.perCore}
                      palette={palette}
                      height={layout.compact ? 44 : 56}
                    />
                  </>
                ) : null}
              </Card>
            </View>
            <View style={{ flex: 1 }}>
              <Card
                chrome={chrome}
                title="Memory over time"
                subtitle={`${formatBytes(data.memory.usedBytes)} of ${formatBytes(data.memory.totalBytes)}`}
              >
                <StackedColumnChart
                  chrome={chrome}
                  columns={memColumns}
                  colors={[palette.series[0], palette.series[1], palette.series[2]]}
                  palette={palette}
                  slots={stackSlots}
                  height={layout.compact ? 110 : 180}
                  topLabel={formatBytes(data.memory.totalBytes, 0)}
                  midLabel={formatBytes(data.memory.totalBytes / 2, 0)}
                  bottomLabel="0"
                  caption={span}
                />
                <Legend
                  chrome={chrome}
                  items={parts.map((part, index) => ({
                    label: part.label,
                    value: formatBytes(data.memory[part.key]),
                    color: palette.series[index],
                  }))}
                />
                <Text style={styles.muted}>
                  Headroom above the stack is free or reclaimable cache · cache{" "}
                  {formatBytes(data.memory.cachedBytes)}
                </Text>
              </Card>
            </View>
          </View>
        </>
      ) : null}

      {/* Bottom band, 360px : 1fr — resources on the left, processes on the right. */}
      <View style={styles.band}>
        <View style={[{ gap: layout.compact ? 10 : 14 }, layout.compact ? null : { width: 360 }]}>
          {data ? (
            <Card chrome={chrome} title="Disk & swap" subtitle={data.disk.mountedOn}>
              <View style={{ gap: 6 }}>
                <View style={styles.row}>
                  <Text style={styles.muted}>Capacity used</Text>
                  <Text style={styles.valueStrong}>{formatPercent(data.disk.usedPercent)}</Text>
                </View>
                <Meter
                  percent={data.disk.usedPercent}
                  color={diskSeverity === "good" ? palette.series[3] : palette.status[diskSeverity]}
                  palette={palette}
                  height={10}
                />
              </View>
              <MetricRow chrome={chrome} label="Used" value={formatBytes(data.disk.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.disk.freeBytes)} />

              <View style={styles.divider} />

              {hasSwap ? (
                <>
                  <View style={{ gap: 6 }}>
                    <View style={styles.row}>
                      <Text style={styles.muted}>Swap in use</Text>
                      <Text style={styles.valueStrong}>
                        {formatBytes(data.swap.usedBytes)} of {formatBytes(data.swap.totalBytes)}
                      </Text>
                    </View>
                    <Meter percent={swapPercent} color={palette.series[2]} palette={palette} height={10} />
                  </View>
                  <MetricRow chrome={chrome} label="Free" value={formatBytes(data.swap.freeBytes)} />
                </>
              ) : (
                <MetricRow chrome={chrome} label="Swap" value={mac ? "None in use" : "None configured"} />
              )}

              <View style={styles.divider} />

              <MetricRow
                chrome={chrome}
                label="Power"
                value={
                  data.power.source === "ac"
                    ? `AC power${data.power.percent === null ? "" : ` · ${formatPercent(data.power.percent)}`}`
                    : data.power.source === "battery"
                      ? `Battery · ${formatPercent(data.power.percent)}`
                      : data.power.source === "none"
                        ? "No battery or adapter reported"
                        : "Unknown"
                }
              />
              {data.power.timeRemainingMinutes !== null ? (
                <MetricRow
                  chrome={chrome}
                  label="Remaining"
                  value={formatMinutes(data.power.timeRemainingMinutes)}
                />
              ) : null}
              <MetricRow
                chrome={chrome}
                label="Thermal"
                value={
                  data.thermal.celsius === null
                    ? THERMAL_LABEL[data.thermal.level]
                    : `${data.thermal.celsius.toFixed(0)} °C${
                        data.thermal.level === "unknown" ? "" : ` · ${THERMAL_LABEL[data.thermal.level]}`
                      }`
                }
              />
            </Card>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <ProcessesSection chrome={chrome} hostId={host.id} palette={palette} live={live} />
        </View>
      </View>
    </ScrollView>
  );
}

function DetailCard({
  chrome,
  title,
  onClose,
  children,
}: {
  chrome: Chrome;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={[styles.card, { borderColor: chrome.theme.colors.accent }]}>
      <View style={styles.row}>
        <Text style={styles.cardTitle}>{title}</Text>
        <ActionButton chrome={chrome} variant="ghost" label="Close" onPress={onClose} />
      </View>
      {children}
    </View>
  );
}


export type TabId = "overview" | "services" | "docker";

const TABS: readonly { id: TabId; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "services", title: "Ports & services" },
  { id: "docker", title: "Docker" },
];

/** `?tab=` from a 0.11 screen link; anything unknown, or no params at all, is the overview. */
function tabFromParams(params: MachineScreenProps["params"]): TabId {
  return TABS.find((entry) => entry.id === params?.tab)?.id ?? "overview";
}

/**
 * Only the selected tab is mounted. The services tab runs ss and docker on a
 * timer, and mounting it in the background would keep that running for a panel
 * nobody is looking at. Paseo keeps this screen mounted, hidden, under a screen
 * opened on top of it, so the tabs read the daemon only while it is the one on
 * screen: the page says when it is hidden on desktop and web, and the sidebar
 * row says which screen is current everywhere.
 */
export function MachineStatusSurface(props: MachineScreenProps) {
  const chrome: Chrome = { theme: props.theme, compact: props.layout.compact };
  const styles = useChromeStyles(chrome);
  const linkedTab = tabFromParams(props.params);
  const [tab, setTab] = useState<TabId>(linkedTab);
  // Opening the already-open screen with another `tab` swaps params without a remount.
  useEffect(() => setTab(linkedTab), [linkedTab]);

  const root = useRef<View>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => watchShown(root.current, setShown), []);
  const current = useCurrentScreen(props.host.id);
  const live = shown && current;

  return (
    <ContextMenuProvider chrome={chrome}>
      <View ref={root} style={styles.screen}>
      <View
        style={{
          flexDirection: "row",
          gap: props.layout.compact ? 16 : 24,
          paddingHorizontal: props.layout.compact ? 12 : 20,
          paddingTop: props.layout.compact ? 10 : 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: paletteFor(props.theme.colors.surface0).border,
        }}
      >
        {TABS.map((entry) => {
          const active = entry.id === tab;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={entry.title}
              onPress={() => setTab(entry.id)}
              style={({ pressed }) => ({
                paddingBottom: 10,
                borderBottomWidth: 2,
                borderBottomColor: active ? props.theme.colors.accent : "transparent",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={[
                  styles.value,
                  { fontWeight: "600" },
                  active ? null : { color: props.theme.colors.foregroundMuted },
                ]}
              >
                {entry.title}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "overview" ? <OverviewTab {...props} live={live} /> : null}
      {tab === "services" ? <ServicesTab {...props} live={live} /> : null}
      {tab === "docker" ? <DockerTab {...props} live={live} /> : null}
      </View>
    </ContextMenuProvider>
  );
}
