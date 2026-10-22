import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, SettingsCard, SettingsRow, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { listMcps, listProjects, setMcp } from "../shared/rpc";

type Theme = PluginScreenProps["theme"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Layout and type scale follow ZeroSub's accounts page, so the two read as one app.
export function McpScreen({ theme, layout }: PluginScreenProps) {
  const fetchProjects = useRpc(listProjects);
  const fetchMcps = useRpc(listMcps);
  const changeMcp = useRpc(setMcp);
  const [picked, setPicked] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["mcp-toggle", "projects"], queryFn: () => fetchProjects({}) });
  const path = picked ?? projects.data?.[0]?.path ?? null;
  const mcps = useQuery({
    queryKey: ["mcp-toggle", "mcps", path],
    queryFn: async () => (await fetchMcps({ cwds: [path as string] }))[path as string] ?? [],
    enabled: path !== null,
  });
  const toggle = useMutation({ mutationFn: changeMcp, onSettled: () => mcps.refetch() });

  if (projects.isPending) return <Loading />;

  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted, fontSize: 13 };
  const danger = { color: colors.statusDanger, fontSize: 13 };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 20 : 28,
          maxWidth: 750,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.4 }}>Claude</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">
              MCP servers
            </Text>
            <RefreshButton
              theme={theme}
              busy={projects.isFetching || mcps.isFetching}
              onPress={() => void Promise.all([projects.refetch(), mcps.refetch()])}
            />
          </View>
          <Text style={muted}>
            Turn Claude's MCP servers on or off for each project. New sessions start with this set; to change a running
            chat, use the mcp pill above its composer.
          </Text>
        </View>

        <Section theme={theme} title="Project">
          {projects.error ? (
            <Text style={danger}>Could not load projects: {message(projects.error)}</Text>
          ) : (
            <SettingsCard>
              <SettingsSelect
                label="Show servers for"
                hint="A subfolder or worktree uses its repository's list."
                value={path ?? ""}
                options={(projects.data ?? []).map((project) => ({ label: project.name, value: project.path }))}
                onValueChange={setPicked}
              />
            </SettingsCard>
          )}
        </Section>

        {path !== null && (
          <Section theme={theme} title="Servers">
            {mcps.isPending ? (
              <Text style={muted}>Loading servers…</Text>
            ) : mcps.error ? (
              <Text style={danger}>Could not read Claude's MCP servers: {message(mcps.error)}</Text>
            ) : mcps.data.length === 0 ? (
              <Text style={muted}>Claude has no MCP servers for this project.</Text>
            ) : (
              <SettingsCard>
                {mcps.data.map((server) => (
                  <SettingsSwitch
                    key={server.name}
                    label={server.name}
                    hint={server.scope === "user" ? "Available in every project" : "Added to this project only"}
                    value={server.enabled}
                    disabled={toggle.isPending}
                    error={toggle.error && toggle.variables?.name === server.name ? message(toggle.error) : null}
                    onValueChange={(enabled) => toggle.mutate({ cwd: path, name: server.name, enabled })}
                  />
                ))}
              </SettingsCard>
            )}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function RefreshButton({ theme, busy, onPress }: { theme: Theme; busy: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name="RefreshCw" size={15} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}
