/**
 * Chart palette and geometry. Pure values and pure functions only, so the colour
 * decisions and the bar maths are both testable without a renderer.
 *
 * Paseo never says which theme is active, so the data palette is chosen by
 * measuring the luminance of `surface0`. Chrome comes from the theme; series
 * colour does not — a categorical hue has to stay the same hue across themes or
 * it stops identifying anything.
 *
 * The dark palette is Monokai Pro Darker's (the Spectrum filter on #1e1e1e), to
 * match the Monokai themes in this repo. Light themes keep a palette with enough
 * contrast on white, where Monokai's yellow and green would not read.
 */

export type Severity = "good" | "warning" | "serious" | "critical";

export interface VizPalette {
  /** Categorical slots in fixed order. Assigned by slot, never cycled. */
  series: readonly [string, string, string, string];
  /** For "free"/"unused" remainders, which are an absence rather than a category. */
  neutral: string;
  grid: string;
  /**
   * Hairline ring. Deliberately NOT a text token: `foregroundMuted` is tuned to be
   * legible as type, which makes it far too loud for a 1px edge.
   */
  border: string;
  borderStrong: string;
  /** Severity colours. Always paired with a text label, never the only signal. */
  status: Readonly<Record<Severity, string>>;
}

/** Monokai Pro Darker: cyan, purple, green and orange for data; yellow and red only for status. */
export const DARK_PALETTE: VizPalette = {
  series: ["#5ad4e6", "#948ae3", "#7bd88f", "#fd9353"],
  neutral: "#363537",
  grid: "#2d2c2e",
  border: "rgba(247,241,255,0.10)",
  borderStrong: "rgba(247,241,255,0.18)",
  status: { good: "#7bd88f", warning: "#fce566", serious: "#fd9353", critical: "#fc618d" },
};

export const LIGHT_PALETTE: VizPalette = {
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  neutral: "#c3c2b7",
  grid: "#e1e0d9",
  border: "rgba(11,11,11,0.10)",
  borderStrong: "rgba(11,11,11,0.18)",
  status: { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" },
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, or null when the colour is in a format we cannot read. */
export function relativeLuminance(color: string): number | null {
  const trimmed = color.trim();

  const hex = HEX.exec(trimmed);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
    const [r, g, b] = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  const rgb = RGB.exec(trimmed);
  if (rgb) {
    const [r, g, b] = [1, 2, 3].map((index) => Number(rgb[index]));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  return null;
}

/** Unreadable colour formats fall back to dark, which is Paseo's default. */
export function isDarkSurface(color: string): boolean {
  const luminance = relativeLuminance(color);
  return luminance === null ? true : luminance < 0.4;
}

export function paletteFor(surface: string): VizPalette {
  return isDarkSurface(surface) ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Severity for a utilisation percentage. Always paired with a text label in the
 * UI: a status colour never carries the meaning on its own.
 */
export function severityOf(percent: number | null, warnAt = 75, criticalAt = 90): Severity {
  if (percent === null || !Number.isFinite(percent)) return "good";
  if (percent >= criticalAt) return "critical";
  if (percent >= warnAt) return "warning";
  return "good";
}

/**
 * Memory keeps higher thresholds than CPU: Linux fills spare memory on purpose,
 * and only the last few percent hurt.
 */
export function cpuSeverity(busyPercent: number | null): Severity {
  return severityOf(busyPercent);
}

export function memorySeverity(usedPercent: number | null): Severity {
  return severityOf(usedPercent, 80, 92);
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  good: "OK",
  warning: "High",
  serious: "Serious",
  critical: "Critical",
};

/** Column heights as percentages, for a bar-per-sample chart. */
export function columnHeights(values: readonly number[], min: number, max: number): number[] {
  const span = max - min;
  if (span <= 0) return values.map(() => 0);
  return values.map((value) => {
    const clamped = Math.max(min, Math.min(max, value));
    return ((clamped - min) / span) * 100;
  });
}

/**
 * Splits one stacked column into segment percentages of `total`. The remainder is
 * returned as the last entry so the column always sums to 100.
 */
export function stackedColumn(parts: readonly number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0).concat(100);
  const segments = parts.map((part) => Math.max(0, (part / total) * 100));
  const used = segments.reduce((sum, segment) => sum + segment, 0);
  return segments.concat(Math.max(0, 100 - used));
}

/**
 * Right-aligns a series into a fixed number of slots, padding the left with nulls.
 *
 * A live monitor's plot has a constant width whether or not history has filled it:
 * the newest sample belongs at the right edge next to "now", and the empty left is
 * the honest picture of how much history exists. Stretching a handful of samples
 * across the full width would instead imply they span the whole window.
 */
export function padSlots<T>(values: readonly T[], slots: number): (T | null)[] {
  if (slots <= 0) return [];
  if (values.length >= slots) return values.slice(values.length - slots) as T[];
  return [...new Array<null>(slots - values.length).fill(null), ...values];
}

export function takeLast<T>(items: readonly T[], count: number): T[] {
  return count >= items.length ? [...items] : items.slice(items.length - count);
}

/** Human span between the first and last sample, for an honest axis caption. */
export function spanLabel(first: string | undefined, last: string | undefined): string {
  if (!first || !last) return "no history yet";
  const seconds = Math.round((Date.parse(last) - Date.parse(first)) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "just started";
  if (seconds < 90) return `last ${seconds}s`;
  return `last ${Math.round(seconds / 60)} min`;
}
