import type { z } from "zod";
import { binary, describeError, run, runStreams, tryRun } from "./exec.ts";
import type {
  controlContainer,
  pruneDocker,
  readContainerLogs,
  readDocker,
  removeImage,
  DockerContainer,
  DockerEngine,
  DockerImage,
  DockerUsageRow,
} from "../shared/docker.ts";

type ReadOutput = z.output<typeof readDocker.output>;
type ControlInput = z.output<typeof controlContainer.input>;
type PruneInput = z.output<typeof pruneDocker.input>;
type LogsInput = z.output<typeof readContainerLogs.input>;
type ImageInput = z.output<typeof removeImage.input>;

const docker = () => binary("docker");
const PS_FORMAT = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}";

/**
 * Docker reports sizes in SI units in `system df` (`5.874GB`) and binary units in
 * `stats` (`31.39MiB`). Both appear, so both are read.
 */
const UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

export function parseDockerSize(value: string): number {
  const match = /^\s*([\d.]+)\s*([A-Za-z]*)\s*$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * (UNITS[match[2].toUpperCase()] ?? 1);
}

export function parseContainers(raw: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of raw.split("\n")) {
    const [id, name, image, state, status, ports] = line.split("\t");
    if (!id || !name) continue;
    const published = new Set<number>();
    // "0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp" — the published side is what
    // is reachable from this machine.
    for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) published.add(Number(match[1]));
    containers.push({
      id,
      name,
      image: image ?? "",
      state: state ?? "",
      status: status ?? "",
      ports: [...published].sort((left, right) => left - right),
      running: state === "running",
    });
  }
  return containers;
}

const VOLUME_LABEL = "Local Volumes";

/**
 * Reads `docker system df`. Volumes are marked unsafe to reclaim: they are where
 * container data lives, and the biggest reclaimable number on a dev machine is
 * usually a database someone still wants.
 */
export function parseSystemDf(raw: string): DockerUsageRow[] {
  const rows: DockerUsageRow[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const match = /^(\S+(?: \S+)?)\s+(\d+)\s+(\d+)\s+([\d.]+\s*\w+)\s+([\d.]+\s*\w+)/.exec(line.trim());
    if (!match) continue;
    const label = match[1];
    rows.push({
      label,
      total: Number(match[2]),
      active: Number(match[3]),
      sizeBytes: parseDockerSize(match[4]),
      reclaimableBytes: parseDockerSize(match[5]),
      safeToReclaim: label !== VOLUME_LABEL,
    });
  }
  return rows;
}

export function parseImages(raw: string): DockerImage[] {
  const images: DockerImage[] = [];
  for (const line of raw.split("\n")) {
    const [id, reference, size, created] = line.split("\t");
    if (!id || !reference) continue;
    images.push({
      id,
      reference,
      sizeBytes: parseDockerSize(size ?? "0B"),
      created: created ?? "",
      // An untagged image is a leftover layer set, which is what prune targets.
      dangling: reference.startsWith("<none>"),
    });
  }
  return images;
}

/** The first line Docker prints on stderr when the daemon does not answer. */
function firstErrorLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : describeError(error);
  return text.trim().split("\n")[0] ?? "";
}

/**
 * `docker system df` sizes every image, container and volume, and takes seconds
 * on a machine with many of them: 9 s here with 139 containers. It never blocks a
 * read for long; it runs in the background, the tab shows the last figures, and
 * they refresh every five minutes and after anything this panel removes.
 */
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_WAIT_MS = 1_500;
let usage: { at: number; raw: string | null } | null = null;
let measuring: Promise<void> | null = null;
let version: string | null = null;

function measureUsage(): Promise<void> {
  measuring ??= tryRun(docker(), ["system", "df"], 120_000)
    .then((raw) => {
      usage = { at: Date.now(), raw };
    })
    .finally(() => {
      measuring = null;
    });
  return measuring;
}

function invalidateUsage(): void {
  usage = null;
  void measureUsage();
}

/** The latest figures, waiting briefly only when there are none yet. */
async function readUsage(): Promise<{ raw: string | null; pending: boolean }> {
  if (!usage || Date.now() - usage.at > USAGE_TTL_MS) {
    const done = measureUsage();
    if (!usage) await Promise.race([done, new Promise((resolve) => setTimeout(resolve, USAGE_WAIT_MS))]);
  }
  return { raw: usage?.raw ?? null, pending: usage === null };
}

/**
 * On Linux the engine is a system service, and on macOS an app (Docker Desktop,
 * OrbStack, Colima). Starting it is not the panel's to do, so it reports why the
 * daemon did not answer instead of offering a button that may not work.
 */
export async function readDockerHandler(): Promise<ReadOutput> {
  const collectedAt = new Date().toISOString();
  const unavailable = (engine: DockerEngine, reason: string): ReadOutput => ({
    engine,
    available: false,
    reason,
    collectedAt,
    containers: [],
    images: [],
    usage: [],
    notes: [],
  });

  if (!docker().startsWith("/")) {
    return unavailable(
      { state: "missing", version: null, detail: null },
      "Docker is not installed on this machine.",
    );
  }

  // `docker ps` doubles as the liveness check, so a healthy poll is two calls.
  let psRaw: string;
  try {
    psRaw = await run(docker(), ["ps", "-a", "--format", PS_FORMAT], 10_000);
  } catch (error) {
    version = null;
    usage = null;
    const detail = firstErrorLine(error);
    return unavailable(
      { state: "stopped", version: null, detail },
      /permission denied/i.test(detail)
        ? "This user may not use the Docker socket. Add it to the docker group, then log in again."
        : process.platform === "darwin"
          ? "The Docker daemon is not running. Open Docker Desktop, or start the engine you use."
          : "The Docker daemon is not running. Start it with `sudo systemctl start docker`.",
    );
  }

  version ??= (await tryRun(docker(), ["version", "--format", "{{.Server.Version}}"], 5_000))?.trim() || null;
  const [{ raw: dfRaw, pending }, imagesRaw] = await Promise.all([
    readUsage(),
    tryRun(docker(), ["images", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"], 10_000),
  ]);

  const containers = parseContainers(psRaw);
  const usageRows = parseSystemDf(dfRaw ?? "");
  const notes: string[] = [];

  const volumes = usageRows.find((row) => row.label === VOLUME_LABEL);
  if (volumes && volumes.reclaimableBytes > 0) {
    notes.push(
      "Unused volumes are counted as reclaimable by Docker, but they hold container data — this panel never offers to remove them.",
    );
  }
  if (pending) notes.push("Measuring disk usage; Docker takes a few seconds to size everything.");
  else if (dfRaw === null) notes.push("Disk usage was not readable.");

  return {
    engine: { state: "running", version, detail: null },
    available: true,
    reason: null,
    collectedAt,
    containers,
    images: parseImages(imagesRaw ?? ""),
    usage: usageRows,
    notes,
  };
}

export async function readContainerLogsHandler({ id, lines }: LogsInput) {
  try {
    const { stdout, stderr } = await runStreams(
      docker(),
      ["logs", "--tail", String(lines), "--timestamps", id],
      20_000,
    );
    return { ok: true, text: `${stdout}${stderr}`.trimEnd(), error: null };
  } catch (error) {
    return { ok: false, text: "", error: describeError(error) };
  }
}

export async function removeImageHandler({ id }: ImageInput) {
  try {
    await run(docker(), ["rmi", id], 60_000);
    invalidateUsage();
    return { ok: true, error: null };
  } catch (error) {
    console.error(`[machine-status] docker rmi failed for ${id}`, error);
    return { ok: false, error: describeError(error) };
  }
}

export async function controlContainerHandler({ id, action }: ControlInput) {
  try {
    // `remove` is only ever reached through the confirmation menu in the panel.
    const args = action === "remove" ? ["rm", id] : [action, id];
    await run(docker(), args, 60_000);
    invalidateUsage();
    return { ok: true, error: null };
  } catch (error) {
    console.error(`[machine-status] docker ${action} failed for ${id}`, error);
    return { ok: false, error: describeError(error) };
  }
}

/** Matches the "Total reclaimed space: 1.234GB" line Docker prints after a prune. */
export function parseReclaimed(raw: string): number {
  const match = /Total reclaimed space:\s*([\d.]+\s*\w+)/i.exec(raw);
  return match ? parseDockerSize(match[1]) : 0;
}

export async function pruneDockerHandler({ target }: PruneInput) {
  // Images are pruned dangling-only. `-a` would delete every image not currently
  // in use by a container, which on a dev machine means re-pulling gigabytes.
  const args = target === "containers" ? ["container", "prune", "-f"] : ["image", "prune", "-f"];
  try {
    const reclaimedBytes = parseReclaimed(await run(docker(), args, 120_000));
    invalidateUsage();
    return { ok: true, reclaimedBytes, error: null };
  } catch (error) {
    console.error(`[machine-status] docker prune ${target} failed`, error);
    return { ok: false, reclaimedBytes: 0, error: describeError(error) };
  }
}
