import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMemo, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { findHostRuntimeStore } from "./app";
import { readRun, subscribeRun, updateAllPlugins, type HostUpdate, type PluginChange } from "./updates";

declare const console: { warn(...args: unknown[]): void };

export function startUpdates() {
  void updateAllPlugins(findHostRuntimeStore()).catch((error: unknown) => console.warn("[command-panel] updates:", error));
}

const change = ({ id, from, to }: PluginChange) => (from && to ? `${id} ${from} → ${to}` : id);

function hostSummary(host: HostUpdate): { label: string; error?: string } {
  switch (host.state) {
    case "checking":
      return { label: "Checking for updates…" };
    case "updating":
      return { label: `Updating ${host.updated.map(change).join(", ")}…` };
    case "failed":
      return { label: "Could not update", error: host.error };
    case "done":
      return { label: host.updated.length > 0 ? `Updated ${host.updated.map(change).join(", ")}` : host.failed.length > 0 ? "Nothing updated" : "Up to date" };
  }
}

/** The last Update All Plugins run, host by host, with a button to run it again. */
export function UpdatesScreen({ theme, layout }: PluginScreenProps) {
  const run = useSyncExternalStore(subscribeRun, readRun);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      note: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, layout.compact],
  );
  const running = run !== null && !run.finished;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SettingsSection title="Plugins on every host">
        <SettingsCard>
          <SettingsAction
            label={running ? "Updating…" : "Update all plugins"}
            hint="Installs each plugin's newest version on every host the app is connected to, like paseo plugin update --all --yes."
            actionLabel={run ? "Run again" : "Update"}
            disabled={running}
            onPress={startUpdates}
          />
        </SettingsCard>
      </SettingsSection>
      {run?.hosts.map((host) => {
        const summary = hostSummary(host);
        return (
          <SettingsSection key={host.serverId} title={host.label}>
            <SettingsCard>
              <SettingsRow label={summary.label} error={summary.error} />
              {host.failed.map((failure) => (
                <SettingsRow key={failure.id} label={`${failure.id} failed`} error={failure.error} />
              ))}
              {host.local.length > 0 ? (
                <SettingsRow label={`Local folders: ${host.local.join(", ")}`} hint="Reload these after editing them; they have no newer version to install." />
              ) : null}
              {host.warnings.map((warning) => (
                <SettingsRow key={warning} label={warning} />
              ))}
            </SettingsCard>
          </SettingsSection>
        );
      })}
      {run?.hosts.length === 0 ? <Text style={styles.note}>The app has no hosts.</Text> : null}
    </ScrollView>
  );
}
