import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";

/** Settings → Plugins → zerosub. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({ theme, host, onOpenAccounts }: PluginSurfaceProps & { onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const multiHost = useHosts().length > 1;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [usageHosts, setUsageHosts] = useState<string | null>(null);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  const save = (patch: Partial<Preferences>) =>
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
    <>
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={settings.values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="The agent moves to the account with the most room left."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends the follow-up below so the interrupted task continues."
            value={settings.values.autoContinue}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            label="Follow-up message"
            initialValue={settings.values.continuePrompt}
            onChangeText={setPrompt}
            disabled={settings.saving || !settings.values.autoContinue}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || prompt === null || !prompt.trim()}
            onPress={() => {
              if (prompt?.trim()) save({ continuePrompt: prompt.trim() });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || settings.values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and resets">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New agents start on the account with the most room instead of the default."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Usage across hosts">
        <SettingsCard>
          <SettingsInput
            label="Hosts that share usage readings, in order"
            hint="Host names or server IDs separated by commas, this host included, e.g. ragdevbox, ragmini, ragair. Before asking the provider, this host takes a recent reading from the hosts before it. Hosts that can't be reached are skipped."
            initialValue={settings.values.usageHosts.join(", ")}
            onChangeText={setUsageHosts}
            disabled={settings.saving}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the host order"
            actionLabel="Save"
            disabled={settings.saving || usageHosts === null}
            onPress={() => {
              if (usageHosts !== null) save({ usageHosts: hostList(usageHosts) });
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

function hostList(text: string): string[] {
  return text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}
