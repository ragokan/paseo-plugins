import type { PluginHostSummary, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts } from "@getpaseo/plugin/client";
// The 0.12 app has Icon only here; 0.13 moved it to client/ui and keeps this as an alias.
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";
import { alwaysHidden, readHidden, setHidden, subscribe } from "./hosts";

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
    queryKey: ["hide-workspaces", online],
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

/** Settings → Plugins: every group of every host the sidebar shows, then the hidden ones. */
export function HideWorkspacesSettings({ theme }: PluginSurfaceProps) {
  const hidden = useSyncExternalStore(subscribe, readHidden);
  const hosts = useHosts();
  const listing = useHostListings(hosts);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hostName = (serverId: string) => hosts.find((host) => host.serverId === serverId)?.label.trim() || serverId;
  // Hiding goes by name, so one row per name, with the hosts that have it.
  const hostsByName = new Map<string, string[]>();
  for (const host of listing.data ?? []) {
    if (!("names" in host)) continue;
    for (const name of new Set(host.names)) hostsByName.set(name, [...(hostsByName.get(name) ?? []), hostName(host.serverId)]);
  }
  const needle = query.trim().toLowerCase();
  const shown = [...hostsByName.keys()]
    .filter((name) => !hidden.has(name) && !alwaysHidden(name))
    .filter((name) => !needle || `${name} ${hostsByName.get(name)!.join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));

  const toggleHidden = async (name: string, hide: boolean) => {
    setSaving(name);
    setSaveError(null);
    try {
      await setHidden(name, hide);
    } catch (error) {
      setSaveError(message(error));
    } finally {
      setSaving(null);
    }
  };
  // Picked ones, then those listed that start with a digit, which stay hidden whatever is picked.
  const hiddenNames = [...new Set([...hidden, ...[...hostsByName.keys()].filter(alwaysHidden)])].sort((a, b) => a.localeCompare(b));

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const failures = (listing.data ?? []).flatMap((host) => ("error" in host ? [host] : []));
  const offline = hosts.filter((host) => host.status !== "online");
  // A hidden name that is not listed stays hidden: its host may only be offline.
  const missingHint = listing.isPending ? undefined : "Not on any online host";

  return (
    <>
      {saveError && <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{saveError}</Text>}
      <SettingsSection
        title="Shown"
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
          ) : shown.length === 0 ? (
            <SettingsRow label={needle ? "No workspace matches" : "Every workspace is hidden"} />
          ) : (
            shown.map((name) => (
              <SettingsRow key={name} label={name} hint={hostsByName.get(name)!.join(", ")}>
                <IconButton
                  theme={theme}
                  icon="EyeOff"
                  label="Hide from sidebar"
                  busy={saving === name}
                  onPress={() => void toggleHidden(name, true)}
                />
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

      <SettingsSection title="Hidden">
        <SettingsCard>
          {hiddenNames.length === 0 ? (
            <SettingsRow label="Nothing hidden" hint="Hide workspaces from the list above." />
          ) : (
            hiddenNames.map((name) =>
              alwaysHidden(name) ? (
                <SettingsRow key={name} label={name} hint="Starts with a digit, so always hidden" />
              ) : (
                <SettingsRow key={name} label={name} hint={hostsByName.get(name)?.join(", ") ?? missingHint}>
                  <IconButton
                    theme={theme}
                    icon="Eye"
                    label="Show in sidebar"
                    busy={saving === name}
                    onPress={() => void toggleHidden(name, false)}
                  />
                </SettingsRow>
              ),
            )
          )}
        </SettingsCard>
        <Text style={muted}>
          Hidden workspaces leave the sidebar with their chats, pinned ones included, here and on your phone. The list is
          saved on each host. Workspaces whose name starts with a digit are always hidden.
        </Text>
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
