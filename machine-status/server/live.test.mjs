// Runs the real handlers against this Linux machine. Every process it signals is one it started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { test } from "node:test";

const skip = process.platform !== "linux" && "needs Linux";
const { readMetricsHandler, resetHistory } = await import("./metrics.ts");
const { killProcessHandler, listProcessesHandler } = await import("./processes.ts");
const { readServicesHandler } = await import("./services.ts");
const { explainProcessHandler } = await import("./explain.ts");
const { readDockerHandler } = await import("./docker.ts");

const context = { paseo: { agents: { list: async () => ({ entries: [] }) } } };

function start(code) {
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  return child;
}

test("metrics match /proc/meminfo and grow a history", { skip }, async () => {
  resetHistory();
  const first = await readMetricsHandler();
  const second = await readMetricsHandler();
  const total = Number(/^MemTotal:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))[1]) * 1024;
  assert.equal(first.memory.totalBytes, total);
  assert.ok(first.memory.usedPercent > 0 && first.memory.usedPercent < 100);
  assert.ok(first.cpu.busyPercent >= 0 && first.cpu.busyPercent <= 100);
  assert.ok(first.disk.totalBytes > 0 && first.disk.mountedOn.startsWith("/"));
  assert.equal(second.history.length, 2);
});

test("a process that starts spinning tops the CPU list, and can be stopped", { skip }, async () => {
  const spinner = start("while (true) {}");
  try {
    await listProcessesHandler({ sortBy: "cpu", limit: 8 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const { items } = await listProcessesHandler({ sortBy: "cpu", limit: 8 });
    const row = items.find((item) => item.pid === spinner.pid);
    assert.ok(row, `spinner ${spinner.pid} missing from ${JSON.stringify(items.map((item) => [item.pid, item.name, item.cpuPercent]))}`);
    assert.ok(row.cpuPercent > 60, `spinner at ${row.cpuPercent}%`);
    assert.equal(row.command, process.execPath);
    assert.equal(row.guarded, false);

    const explained = await explainProcessHandler({ pid: spinner.pid }, context);
    assert.equal(explained.found, true);
    assert.match(explained.explanation.findings.join(" "), /It started \d\d:\d\d ago|running for/);

    const killed = await killProcessHandler({ pid: spinner.pid, signal: "TERM" });
    assert.deepEqual(killed, { ok: true, pid: spinner.pid, signal: "TERM", stillRunning: false, error: null });
  } finally {
    spinner.kill("SIGKILL");
  }
});

test("the plugin refuses to signal itself or its parents", { skip }, async () => {
  for (const pid of [process.pid, process.ppid]) {
    const result = await killProcessHandler({ pid, signal: "TERM" });
    assert.equal(result.ok, false);
    assert.match(result.error, /refused/);
  }
});

test("a loopback dev server shows up as a local development port with its owner", { skip }, async () => {
  const server = start(
    "require('node:http').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });",
  );
  try {
    const [chunk] = await once(server.stdout, "data");
    const port = Number(String(chunk).trim());
    const { ports } = await readServicesHandler({}, context);
    const row = ports.find((entry) => entry.port === port);
    assert.ok(row, `port ${port} missing`);
    assert.equal(row.pid, server.pid);
    assert.equal(row.scope, "local");
    assert.equal(row.relevance, "dev");
    assert.equal(row.url, `http://127.0.0.1:${port}`);
  } finally {
    server.kill("SIGKILL");
  }
});

test("docker reports its engine state", { skip }, async () => {
  const result = await readDockerHandler();
  assert.ok(["running", "stopped", "missing"].includes(result.engine.state));
  if (result.engine.state === "running") assert.ok(result.engine.version);
  else assert.ok(result.reason);
});
