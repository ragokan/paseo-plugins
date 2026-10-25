import { captureDimension, type Size } from "./logic.ts";

const KEY = Symbol.for("ragokan/paseo-plugins/browseros-neo/quality");
type HostId = string;
type QualityHosts = Set<HostId>;

function hosts(): QualityHosts {
  const shared = globalThis as unknown as Record<symbol, QualityHosts | undefined>;
  return (shared[KEY] ??= new Set());
}

export function rememberedQuality(host: string): boolean { return hosts().has(host); }
export function rememberQuality(host: string, enabled: boolean) {
  if (enabled) hosts().add(host);
  else hosts().delete(host);
}

interface Options {
  qualityMode: boolean;
  compact: boolean;
  native: boolean;
  zoom: boolean;
  box: Size;
  pixelRatio: number;
  shown: Size | null;
}

export function frameSettings({ qualityMode, compact, native, zoom, box, pixelRatio, shown }: Options) {
  let width = box.width * pixelRatio;
  let height = box.height * pixelRatio;
  if (qualityMode) {
    width = shown?.width || 1920;
    height = shown?.height || 1080;
  } else if (zoom) {
    width = shown?.width || width;
    height = shown?.height || height;
  }
  return {
    maxWidth: captureDimension(width),
    maxHeight: captureDimension(height),
    quality: qualityMode ? 95 : compact || native ? 55 : 70,
    lossless: qualityMode,
  };
}
