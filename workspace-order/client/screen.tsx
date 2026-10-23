import type { PluginHostSummary, PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
// The 0.12 app has Icon and ScrollView only here; 0.13 moved them to client/ui and keeps this as an alias.
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { readOrder, saveOrder, subscribeOrder } from "./order";

type Theme = PluginSurfaceProps["theme"];

type HostListing = { serverId: string; names: string[] } | { serverId: string; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The sidebar names a group by its custom name, else its display name.
async function listGroupNames(serverId: string): Promise<string[]> {
  const { projects } = await getPaseoClient(serverId).projects.list();
  return projects.map((project) => project.projectCustomName ?? project.projectDisplayName);
}

// Every online host's groups, fetched when the page opens; getPaseoClient needs a connection.
function useHostListings(hosts: readonly PluginHostSummary[]) {
  const online = hosts.filter((host) => host.status === "online").map((host) => host.serverId);
  return useQuery({
    queryKey: ["workspace-order", online],
    queryFn: () =>
      Promise.all(
        online.map(async (serverId): Promise<HostListing> => {
          try {
            return { serverId, names: await listGroupNames(serverId) };
          } catch (error) {
            return { serverId, error: message(error) };
          }
        }),
      ),
  });
}

/** The ordered names on top, every other group of every host below them. */
export function WorkspaceOrder({ theme }: { theme: Theme }) {
  const order = useSyncExternalStore(subscribeOrder, readOrder);
  const hosts = useHosts();
  const listing = useHostListings(hosts);
  const [query, setQuery] = useState("");

  const hostName = (serverId: string) => hosts.find((host) => host.serverId === serverId)?.label.trim() || serverId;
  // Groups with the same name on several hosts are one sidebar row (merge-projects), so one row here.
  const hostsByName = new Map<string, string[]>();
  for (const host of listing.data ?? []) {
    if (!("names" in host)) continue;
    for (const name of new Set(host.names)) hostsByName.set(name, [...(hostsByName.get(name) ?? []), hostName(host.serverId)]);
  }
  const ordered = new Set(order);
  const needle = query.trim().toLowerCase();
  const rest = [...hostsByName.keys()]
    .filter((name) => !ordered.has(name))
    .filter((name) => !needle || `${name} ${hostsByName.get(name)!.join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));

  const move = (index: number, by: number) => {
    const next = [...order];
    const [name] = next.splice(index, 1);
    next.splice(index + by, 0, name!);
    saveOrder(next);
  };
  const remove = (index: number) => saveOrder(order.filter((_, i) => i !== index));
  const add = (name: string) => saveOrder([...order, name]);

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const failures = (listing.data ?? []).flatMap((host) => ("error" in host ? [host] : []));
  const offline = hosts.filter((host) => host.status !== "online");
  // An ordered name that is not listed keeps its place: its host may only be offline.
  const missingHint = listing.isPending ? undefined : "Not on any online host";

  return (
    <>
      <SettingsSection title="Ordered">
        <SettingsCard>
          {order.length === 0 ? (
            <SettingsRow label="Nothing ordered yet" hint="Add workspaces from the list below." />
          ) : (
            order.map((name, index) => (
              <SettingsRow key={name} label={`${index + 1}. ${name}`} hint={hostsByName.get(name)?.join(", ") ?? missingHint}>
                <View style={{ flexDirection: "row", gap: 2 }}>
                  <IconButton theme={theme} icon="ArrowUp" label="Move up" disabled={index === 0} onPress={() => move(index, -1)} />
                  <IconButton
                    theme={theme}
                    icon="ArrowDown"
                    label="Move down"
                    disabled={index === order.length - 1}
                    onPress={() => move(index, 1)}
                  />
                  <IconButton theme={theme} icon="X" label="Remove from order" onPress={() => remove(index)} />
                </View>
              </SettingsRow>
            ))
          )}
        </SettingsCard>
        <Text style={muted}>
          These lead the sidebar's workspaces, in this order, whichever hosts it shows. The rest follow in Paseo's order.
        </Text>
      </SettingsSection>

      <SettingsSection
        title="Unordered"
        trailing={
          <IconButton
            theme={theme}
            icon="RefreshCw"
            label="Refresh"
            busy={listing.isFetching}
            onPress={() => void listing.refetch()}
          />
        }
      >
        <SettingsCard>
          <SettingsInput label="Find" placeholder="Name or host" onChangeText={setQuery} />
          {listing.isPending ? (
            <SettingsRow label="Loading workspaces…" />
          ) : rest.length === 0 ? (
            <SettingsRow label={needle ? "No workspace matches" : "Every workspace is ordered"} />
          ) : (
            rest.map((name) => (
              <SettingsRow key={name} label={name} hint={hostsByName.get(name)!.join(", ")}>
                <IconButton theme={theme} icon="Plus" label="Add to order" onPress={() => add(name)} />
              </SettingsRow>
            ))
          )}
        </SettingsCard>
        {failures.map((host) => (
          <Text key={host.serverId} style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
            Could not load {hostName(host.serverId)}: {host.error}
          </Text>
        ))}
        {offline.length > 0 && (
          <Text style={muted}>Not listed while offline: {offline.map((host) => hostName(host.serverId)).join(", ")}.</Text>
        )}
      </SettingsSection>
    </>
  );
}

function IconButton({
  theme,
  icon,
  label,
  disabled,
  busy,
  onPress,
}: {
  theme: Theme;
  icon: string;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : 1,
        backgroundColor: !inactive && (pressed || hovered) ? theme.colors.surface2 : "transparent",
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name={icon} size={15} color={theme.colors.foreground} />
      )}
    </Pressable>
  );
}

/** Opened from the sidebar row: the same page with its own scrolling and margins. */
export function WorkspaceOrderScreen({ theme, layout }: PluginScreenProps) {
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 20 : 28,
          maxWidth: 760,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <WorkspaceOrder theme={theme} />
      </ScrollView>
    </View>
  );
}

/** Settings → Plugins renders inside its own scrolling page. */
export function WorkspaceOrderSettings({ theme }: PluginSurfaceProps) {
  return <WorkspaceOrder theme={theme} />;
}
