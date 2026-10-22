import type {
  PluginClientContext,
  PluginHostSummary,
  PluginPopoverProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const document: { scripts: ArrayLike<{ src: string }> };
declare function fetch(url: string): Promise<{ text(): Promise<string> }>;
declare const console: { warn(...args: unknown[]): void };

interface SidebarViewStore {
  getState(): { hostFilters: string[] };
  setState(partial: { hostFilters: string[] }): void;
  subscribe(listener: () => void): () => void;
}

// shortcut: the plugin SDK has no API for the sidebar host filter, so this finds the app's own
// useSidebarViewStore module in its Metro bundle and drives it. Desktop/web only, and breaks if
// Paseo renames that store; switch to an SDK call once one exists.
export async function findSidebarViewStore(): Promise<SidebarViewStore> {
  const bundle = Array.from(document.scripts).find((script) => script.src.includes("/_expo/static/js/"));
  if (!bundle) throw new Error("Paseo app bundle not found");
  const source = await (await fetch(bundle.src)).text();
  const start = source.indexOf('"useSidebarViewStore",{enumerable');
  const end = source.indexOf("\n", start);
  // Each Metro module is one line ending in `},<moduleId>,[<deps>]);`.
  const moduleId = start < 0 ? undefined : /,(\d+),\[[\d,]*\]\);$/.exec(source.slice(start, end < 0 ? undefined : end))?.[1];
  const metroRequire = (globalThis as { __r?: (id: number) => { useSidebarViewStore?: SidebarViewStore } }).__r;
  const store = moduleId && metroRequire ? metroRequire(Number(moduleId)).useSidebarViewStore : undefined;
  if (typeof store?.setState !== "function" || !Array.isArray(store.getState().hostFilters)) {
    throw new Error("Paseo sidebar host filter not found");
  }
  return store;
}

let sidebarViewStore: Promise<SidebarViewStore> | undefined;
const NO_FILTERS: string[] = [];
const noSubscription = () => () => {};

function useSidebarView() {
  const [found, setFound] = useState<{ store?: SidebarViewStore; error?: string }>({});
  useEffect(() => {
    let mounted = true;
    (sidebarViewStore ??= findSidebarViewStore()).then(
      (store) => mounted && setFound({ store }),
      (error) => {
        console.warn("[host-filter]", error);
        if (mounted) setFound({ error: String(error) });
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  const selected = useSyncExternalStore(
    found.store?.subscribe ?? noSubscription,
    () => found.store?.getState().hostFilters ?? NO_FILTERS,
  );
  return { ...found, selected };
}

function useHostOptions(selected: string[]) {
  const hosts = useHosts();
  const nameOf = (serverId: string) => hosts.find((host) => host.serverId === serverId)?.label.trim() || serverId;
  return {
    summary: selected.length === 0 ? "All hosts" : selected.map(nameOf).join(", "),
    options: hosts.map((host) => ({ serverId: host.serverId, name: nameOf(host.serverId), status: host.status })),
  };
}

// Same rule as the app's dock badge (deriveMacDockBadgeCountFromWorkspaceStatuses).
const NEEDS_YOU = new Set(["attention", "needs_input", "failed"]);

async function countNeedsYou(serverId: string) {
  const { workspaces } = getPaseoClient(serverId);
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await workspaces.list({ page: { limit: 200, cursor } });
    count += page.entries.filter((workspace) => NEEDS_YOU.has(workspace.status)).length;
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return count;
}

// Fetched when the dropdown opens; online hosts only, since getPaseoClient needs a connection.
function useNeedsYouCounts(serverIds: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = serverIds.join("\n");
  useEffect(() => {
    let mounted = true;
    for (const serverId of key.split("\n").filter(Boolean)) {
      countNeedsYou(serverId).then(
        (count) => mounted && setCounts((previous) => ({ ...previous, [serverId]: count })),
        (error) => console.warn("[host-filter]", serverId, error),
      );
    }
    return () => {
      mounted = false;
    };
  }, [key]);
  return counts;
}

function HostFilter({ theme, openPopover }: PluginSidebarItemProps) {
  const { store, error, selected } = useSidebarView();
  const { summary } = useHostOptions(selected);
  if (error) return <SidebarRow icon="ServerOff" label={`Host filter unavailable: ${error}`} onPress={() => {}} />;
  if (!store) return null;
  return (
    <SidebarRow
      icon="Server"
      label={summary}
      trailing={<Icon name="ChevronsUpDown" size={14} color={theme.colors.foregroundMuted} />}
      onPress={() => openPopover(HostPicker)}
    />
  );
}

// Mirrors the app's host filter menu: MenuItem rows with a HostStatusDot; selected hosts use
// MenuItem's active background instead of a check. Click picks one host; Cmd/Ctrl-click adds or
// removes a host and keeps the menu open.
function HostPicker({ theme: { colors }, layout, close }: PluginPopoverProps) {
  const { store, selected } = useSidebarView();
  const { options } = useHostOptions(selected);
  const needsYou = useNeedsYouCounts(options.filter((host) => host.status === "online").map((host) => host.serverId));
  if (!store) return null;
  const statusColor = (status: PluginHostSummary["status"]) =>
    status === "online" ? colors.statusSuccess : status === "connecting" ? colors.statusWarning : colors.statusDanger;
  const rows = [
    { key: "all", serverId: null, name: "All hosts", dot: null, active: selected.length === 0, needsYou: 0 },
    ...options.map(({ serverId, name, status }) => ({
      key: serverId,
      serverId,
      name,
      dot: statusColor(status),
      active: selected.includes(serverId),
      needsYou: needsYou[serverId] ?? 0,
    })),
  ];
  return (
    <View style={styles.menu}>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="menuitem"
          accessibilityLabel={row.name}
          accessibilityState={{ selected: row.active }}
          onPress={(event) => {
            const { metaKey, ctrlKey } = event.nativeEvent as { metaKey?: boolean; ctrlKey?: boolean };
            const { serverId } = row;
            if ((metaKey || ctrlKey) && serverId) {
              store.setState({
                hostFilters: row.active ? selected.filter((id) => id !== serverId) : [...selected, serverId],
              });
              return;
            }
            store.setState({ hostFilters: serverId ? [serverId] : [] });
            close();
          }}
          style={(state) => [
            styles.item,
            { minHeight: layout.compact ? 48.4 : 33.9 },
            // react-native-web adds `hovered`; the native types only know `pressed`.
            (row.active || (state as { hovered?: boolean }).hovered || state.pressed) && {
              backgroundColor: colors.surface2,
            },
          ]}
        >
          {row.dot && (
            <View style={styles.slot}>
              <View style={[styles.dot, { backgroundColor: row.dot }]} />
            </View>
          )}
          <Text numberOfLines={1} style={[styles.text, { color: colors.foreground }]}>
            {row.name}
          </Text>
          {row.needsYou > 0 && (
            <View
              accessibilityLabel={`${row.needsYou} need${row.needsYou === 1 ? "s" : ""} you`}
              style={[styles.count, { borderColor: colors.accent }]}
            >
              <Text style={[styles.countText, { color: colors.accent }]}>{row.needsYou}</Text>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  );
}

// Paseo's MenuItem metrics (spacing 4/8, row 28/40, radius md 6, font 14/18), spacing and font 10% larger, rows 21% taller, on request.
const styles = StyleSheet.create({
  // Cancels PluginPopoverContent's 12px padding so rows sit like a native menu's.
  menu: { margin: -12, paddingVertical: 4.4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8.8,
    marginHorizontal: 4.4,
    paddingHorizontal: 8.8,
    paddingVertical: 4.4,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: 6,
  },
  slot: { width: 16, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { flexShrink: 1, minWidth: 0, fontSize: 15.4, lineHeight: 20 },
  // Paseo's tabCountBadge shape, 10% larger like the rest of the menu, in the accent color.
  count: {
    marginLeft: "auto",
    minWidth: 17.6,
    height: 17.6,
    paddingHorizontal: 2,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 2,
    borderWidth: 1,
  },
  countText: { fontSize: 11, lineHeight: 13.2, textAlign: "center", fontWeight: "500", fontVariant: ["tabular-nums"] },
});

export default function contribute(client: PluginClientContext) {
  // The store lookup reads the web bundle, so iOS and Android get no row; their sidebar display menu has the same filter.
  if (Platform.OS !== "web") return () => {};
  return client.addSidebarHeaderItem({ id: "host-filter", title: "Hosts", Component: HostFilter });
}
