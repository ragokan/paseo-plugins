import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INSTRUCTIONS, parseTitle, PROVIDERS, TITLE_SCHEMA, userPrompt, type Candidate } from "./title.ts";

const TIMEOUT_MS = 120_000;
const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface Settings {
  /** Settings → Host → Metadata: the configured models, or none for Automatic. */
  metadataModels: Candidate[];
  /** The command Paseo starts each provider with. */
  commands: Record<string, string[]>;
}

/** Reads the daemon's config.json, which Settings → Host → Metadata writes. */
export function readSettings(home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")): Settings {
  let agents: { metadataGeneration?: { providers?: unknown }; providers?: Record<string, { command?: unknown }> } = {};
  try {
    agents = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).agents ?? {};
  } catch {
    // No config: Automatic, and the commands on PATH.
  }
  const configured = agents.metadataGeneration?.providers;
  const metadataModels = (Array.isArray(configured) ? configured : []).flatMap((entry: Record<string, unknown>) => {
    if (typeof entry?.provider !== "string" || !entry.provider.trim()) return [];
    return [
      {
        provider: entry.provider.trim(),
        ...(typeof entry.model === "string" && entry.model.trim() ? { model: entry.model.trim() } : {}),
        ...(typeof entry.thinkingOptionId === "string" && entry.thinkingOptionId ? { thinkingOptionId: entry.thinkingOptionId } : {}),
      },
    ];
  });
  const commands: Record<string, string[]> = {};
  for (const provider of PROVIDERS) {
    const command = agents.providers?.[provider]?.command;
    const valid = Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string");
    commands[provider] = valid ? (command as string[]) : [provider];
  }
  return { metadataModels, commands };
}

function run(command: readonly string[], args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const [file, ...prefix] = command;
  return new Promise((resolve, reject) => {
    const child = execFile(file!, [...prefix, ...args], { cwd, signal, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file!)} failed: ${error.message}${stderr ? `\n${stderr.slice(-2000)}` : ""}`));
      else resolve(stdout);
    });
    // Codex waits for more prompt while stdin is open.
    child.stdin?.end();
  });
}

// One request with no tools, MCP servers, settings, hooks or saved session, so nothing in it can act.
async function claude(command: readonly string[], candidate: Candidate, message: string, signal: AbortSignal): Promise<string | null> {
  const args = [
    "--print",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "json",
    "--system-prompt",
    INSTRUCTIONS,
    "--json-schema",
    JSON.stringify(TITLE_SCHEMA),
  ];
  if (candidate.model) args.push("--model", candidate.model);
  if (candidate.thinkingOptionId && CLAUDE_EFFORTS.has(candidate.thinkingOptionId)) args.push("--effort", candidate.thinkingOptionId);
  args.push(userPrompt(message));
  const answer = JSON.parse(await run(command, args, os.tmpdir(), signal)) as { is_error?: boolean; result?: unknown; structured_output?: { title?: unknown } };
  if (answer.is_error) throw new Error(`claude answered with an error: ${String(answer.result)}`);
  return parseTitle(answer.structured_output?.title);
}

// A read-only, unsaved run in an empty folder, with the user's Codex config but without its MCP servers.
async function codex(command: readonly string[], candidate: Candidate, message: string, signal: AbortSignal): Promise<string | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-titles-"));
  try {
    const schema = path.join(directory, "schema.json");
    const output = path.join(directory, "title.json");
    await writeFile(schema, JSON.stringify(TITLE_SCHEMA));
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--config",
      "mcp_servers={}",
      "--cd",
      directory,
      "--output-schema",
      schema,
      "--output-last-message",
      output,
    ];
    if (candidate.model) args.push("--model", candidate.model);
    if (candidate.thinkingOptionId) args.push("--config", `model_reasoning_effort=${JSON.stringify(candidate.thinkingOptionId)}`);
    args.push(`${INSTRUCTIONS}\n\n${userPrompt(message)}`);
    await run(command, args, directory, signal);
    return parseTitle((JSON.parse(await readFile(output, "utf8")) as { title?: unknown }).title);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Asks each model in turn until one writes a title, as Paseo falls through its list. */
export async function generateTitle(models: readonly Candidate[], settings: Settings, message: string, signal: AbortSignal): Promise<string> {
  const failures: string[] = [];
  for (const candidate of models) {
    const command = settings.commands[candidate.provider] ?? [candidate.provider];
    const name = `${candidate.provider}/${candidate.model ?? "default"}`;
    try {
      const title = await (candidate.provider === "codex" ? codex : claude)(command, candidate, message, signal);
      if (title) return title;
      failures.push(`${name}: no title in the answer`);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(models.length > 0 ? `no model wrote a title:\n${failures.join("\n")}` : "no Claude or Codex model to write a title with");
}
