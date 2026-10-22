// Runs the real `codex app-server` against a throwaway CODEX_HOME; never touches ~/.codex.
// The app-server tests skip when codex is not installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-toggle-codex-")));
process.env.CODEX_HOME = join(root, "codex");
const { codexMcpsFrom, listCodexMcpsFor, setCodexMcpEnabled } = await import("./codex-config.ts");
const noCodex = spawnSync("codex", ["--version"]).status !== 0 && "codex is not installed";

const user = { type: "user", file: "/home/me/.codex/config.toml", profile: null };
const project = { type: "project", dotCodexFolder: "/repo/.codex" };

test("lists every server with its state and says which ones a switch here cannot change", () => {
  const mcps = codexMcpsFrom({
    config: {
      mcp_servers: {
        cua: { enabled: false },
        docs: {},
        local: {},
        pinned: { enabled: true },
        profiled: { enabled: false },
        managed: { enabled: false },
      },
    },
    origins: {
      "mcp_servers.cua.enabled": { name: user },
      "mcp_servers.pinned.enabled": { name: project },
      "mcp_servers.profiled.enabled": { name: { ...user, profile: "work" } },
      "mcp_servers.managed.enabled": { name: { type: "enterpriseManaged" } },
    },
    layers: [
      { name: project, config: { mcp_servers: { local: { command: "x" }, pinned: { enabled: true } } } },
      { name: user, config: { mcp_servers: { cua: {}, docs: {}, pinned: {}, profiled: {}, managed: {} } } },
    ],
  });
  assert.deepEqual(mcps, [
    { name: "cua", enabled: false, scope: "user" },
    { name: "docs", enabled: true, scope: "user" },
    { name: "local", enabled: true, scope: "project", locked: "Added in this project's .codex/config.toml" },
    { name: "managed", enabled: false, scope: "user", locked: "Switched in Codex's enterpriseManaged config" },
    { name: "pinned", enabled: true, scope: "user", locked: "Switched in this project's .codex/config.toml" },
    { name: "profiled", enabled: false, scope: "user", locked: 'Switched in Codex profile "work"' },
  ]);
  assert.deepEqual(codexMcpsFrom({ config: { mcp_servers: null }, origins: {}, layers: null }), []);
});

const config = join(root, "codex", "config.toml");
const repo = join(root, "repo");
const plain = join(root, "plain");
const USER_CONFIG = `# keep this comment
model = "gpt-5"

[mcp_servers.cua]
command = "echo"
args = ["a"]

[mcp_servers.cua.env]
DISPLAY = ":0"

[mcp_servers.docs]
command = "echo"
enabled = false

[mcp_servers.pinned]
command = "echo"

[projects."${repo}"]
trust_level = "trusted"
`;

function setUp() {
  mkdirSync(join(root, "codex"), { recursive: true });
  mkdirSync(join(repo, ".codex"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  mkdirSync(plain, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  writeFileSync(config, USER_CONFIG);
  writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.local]\ncommand = "echo"\n\n[mcp_servers.pinned]\nenabled = false\n');
}

test("reads each folder's servers with its project's .codex/config.toml applied", { skip: noCodex }, async () => {
  setUp();
  const lists = await listCodexMcpsFor([join(repo, "sub"), plain, join(root, "gone")]);
  assert.deepEqual(lists[join(repo, "sub")], [
    { name: "cua", enabled: true, scope: "user" },
    { name: "docs", enabled: false, scope: "user" },
    { name: "local", enabled: true, scope: "project", locked: "Added in this project's .codex/config.toml" },
    { name: "pinned", enabled: false, scope: "user", locked: "Switched in this project's .codex/config.toml" },
  ]);
  const everywhere = [
    { name: "cua", enabled: true, scope: "user" },
    { name: "docs", enabled: false, scope: "user" },
    { name: "pinned", enabled: true, scope: "user" },
  ];
  assert.deepEqual(lists[plain], everywhere);
  assert.deepEqual(lists[join(root, "gone")], everywhere, "a deleted folder still reads the user config");
});

test("a toggle edits ~/.codex/config.toml in place and applies everywhere", { skip: noCodex }, async () => {
  setUp();
  await setCodexMcpEnabled(join(repo, "sub"), "cua", false);
  const text = readFileSync(config, "utf8");
  assert.equal(text, USER_CONFIG.replace('args = ["a"]\n', 'args = ["a"]\nenabled = false\n'));
  assert.equal((await listCodexMcpsFor([plain]))[plain][0].enabled, false);

  await setCodexMcpEnabled(plain, "docs", true);
  await setCodexMcpEnabled(plain, "cua", true);
  assert.deepEqual(
    (await listCodexMcpsFor([plain]))[plain].map((server) => server.enabled),
    [true, true, true],
  );
  assert.equal(readFileSync(join(repo, ".codex", "config.toml"), "utf8").includes("enabled = false"), true, "project file untouched");
});

test("refuses unknown and locked servers without writing", { skip: noCodex }, async () => {
  setUp();
  await assert.rejects(setCodexMcpEnabled(repo, "nope", false), /no MCP server named "nope"/);
  await assert.rejects(setCodexMcpEnabled(repo, "local", false), /cannot be switched here: Added in this project's/);
  await assert.rejects(setCodexMcpEnabled(repo, "pinned", true), /cannot be switched here: Switched in this project's/);
  assert.equal(readFileSync(config, "utf8"), USER_CONFIG);
});
