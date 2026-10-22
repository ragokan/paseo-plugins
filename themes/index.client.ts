import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

// Monokai Pro filters, upstream palette names: background/text are the extremes,
// dimmed5..dimmed2 the neutral ramp, accent3 the yellow the official UI uses for focus.
type MonokaiFilter = {
  name: string;
  background: string;
  text: string;
  dimmed5: string;
  dimmed4: string;
  dimmed3: string;
  dimmed2: string;
  accent3: string;
};

const monokaiFilters: Record<string, MonokaiFilter> = {
  pro: {
    name: "Monokai Pro",
    background: "#2d2a2e",
    text: "#fcfcfa",
    dimmed5: "#403e41",
    dimmed4: "#5b595c",
    dimmed3: "#727072",
    dimmed2: "#939293",
    accent3: "#ffd866",
  },
  machine: {
    name: "Monokai Pro Machine",
    background: "#273136",
    text: "#f2fffc",
    dimmed5: "#3a4449",
    dimmed4: "#545f62",
    dimmed3: "#6b7678",
    dimmed2: "#8b9798",
    accent3: "#ffed72",
  },
  octagon: {
    name: "Monokai Pro Octagon",
    background: "#282a3a",
    text: "#eaf2f1",
    dimmed5: "#3a3d4b",
    dimmed4: "#535763",
    dimmed3: "#696d77",
    dimmed2: "#888d94",
    accent3: "#ffd76d",
  },
  ristretto: {
    name: "Monokai Pro Ristretto",
    background: "#2c2525",
    text: "#fff1f3",
    dimmed5: "#403838",
    dimmed4: "#5b5353",
    dimmed3: "#72696a",
    dimmed2: "#948a8b",
    accent3: "#f9cc6c",
  },
  spectrum: {
    name: "Monokai Pro Spectrum",
    background: "#222222",
    text: "#f7f1ff",
    dimmed5: "#363537",
    dimmed4: "#525053",
    dimmed3: "#69676c",
    dimmed2: "#8b888f",
    accent3: "#fce566",
  },
  // Spectrum with a darker background, matching monokai_pro_darker.yaml and monokai-pro-darker.json.
  darker: {
    name: "Monokai Pro Darker",
    background: "#1e1e1e",
    text: "#f7f1ff",
    dimmed5: "#363537",
    dimmed4: "#525053",
    dimmed3: "#69676c",
    dimmed2: "#8b888f",
    accent3: "#fce566",
  },
};

// Surface lift. The raw ramp steps are far too heavy for panels and popovers, so blend
// toward them instead of landing on them. Lower numbers = flatter UI; tune these three.
const RAISED_LIFT = 0.3;
const CONTROL_LIFT = 0.4;
const BORDER_LIFT = 0.55;

const mix = (from: string, to: string, amount: number) =>
  `#${[1, 3, 5]
    .map((i) => {
      const a = Number.parseInt(from.slice(i, i + 2), 16);
      const b = Number.parseInt(to.slice(i, i + 2), 16);
      return Math.round(a + (b - a) * amount)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;

export const themes: PluginThemeContribution[] = Object.entries(monokaiFilters).map(
  ([id, filter]) => ({
    id: `monokai-${id}`,
    name: filter.name,
    appearance: "dark" as const,
    colors: {
      background: filter.background,
      foreground: filter.text,
      raised: mix(filter.background, filter.dimmed5, RAISED_LIFT),
      control: mix(filter.background, filter.dimmed4, CONTROL_LIFT),
      border: mix(filter.background, filter.dimmed4, BORDER_LIFT),
      accent: filter.accent3,
      mutedForeground: filter.dimmed2,
      ring: filter.dimmed3,
    },
  }),
);

export default function contribute(client: PluginClientContext) {
  for (const theme of themes) client.addTheme(theme);
  return () => {};
}
