import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Loading, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { APP_FEATURES, HOST_FEATURES, hostFeatureSettings, type HostFeatures } from "../shared/features";
import { canSaveAppFeatures, setAppFeature, useAppFeatures } from "./app-features";

// The host applies its own default for machine status; values arrive with it filled in.
const hostSettings = hostFeatureSettings(false);

interface FeatureSettingsProps extends PluginSurfaceProps {
  onHostChange(features: HostFeatures): void;
}

/** Settings → Plugins → all → Features. */
export function FeatureSettings({ host, onHostChange }: FeatureSettingsProps) {
  return (
    <>
      {canSaveAppFeatures ? <AppSwitches /> : null}
      <HostSwitches hostLabel={host.label} onChange={onHostChange} />
    </>
  );
}

function AppSwitches() {
  const features = useAppFeatures();
  return (
    <SettingsSection title="In this app, for every host">
      <SettingsCard>
        {APP_FEATURES.map((feature) => (
          <SettingsSwitch
            key={feature.id}
            label={feature.title}
            hint={feature.hint}
            value={features[feature.id]}
            onValueChange={(on) => void setAppFeature(feature.id, on)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function HostSwitches({ hostLabel, onChange }: { hostLabel: string; onChange(features: HostFeatures): void }) {
  const settings = useSettings(hostSettings);
  const values = settings.status === "ready" ? settings.values : null;

  // Applies what this screen saves, and what it loads when it opens.
  useEffect(() => {
    if (values) onChange(values);
  }, [values, onChange]);

  const title = `On ${hostLabel}`;
  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={title}>
        <SettingsCard>
          <SettingsRow label="Could not load the switches" error={settings.error} />
          {settings.status === "invalid" ? (
            <SettingsAction label="Start over" hint="Turns every switch back to its default." actionLabel="Reset" onPress={() => void settings.reset()} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const { revision } = settings;
  const features = settings.values;
  return (
    <SettingsSection title={title}>
      <SettingsCard>
        {HOST_FEATURES.map((feature) => (
          <SettingsSwitch
            key={feature.id}
            label={feature.title}
            hint={feature.hint}
            value={features[feature.id]}
            disabled={settings.saving}
            onValueChange={(on) => void settings.save({ ...features, [feature.id]: on }, revision)}
          />
        ))}
        {settings.saveError ? <SettingsRow label="Could not save" error={settings.saveError} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}
