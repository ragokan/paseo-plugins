import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { macHelperSource } from "./macos-source.ts";

test("permission requests happen once per permission and host, surviving helper restarts", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-permissions-"));
  try {
    const start = macHelperSource.indexOf("    private func requestOnce(");
    const end = macHelperSource.indexOf("    private func permissions()", start);
    const requestOnce = macHelperSource.slice(start, end)
      .replace('NSHomeDirectory() + "/Library/Caches/paseo-browseros-neo"', 'CommandLine.arguments[2]');
    const binary = join(directory, "probe");
    await writeFile(binary + ".swift", `import Foundation
import CryptoKit
import Darwin
final class Probe {
    private var requested: Set<String> = []
    private let permissionDirectory = CommandLine.arguments[1]
    private let permissionOwner = ProcessInfo.processInfo.environment["PASEO_BROWSEROS_PERMISSION_OWNER"]!
${requestOnce}
    func run() {
        var count = 0
        for _ in 0..<3 {
            requestOnce("screen-capture") { count += 1 }
            requestOnce("accessibility") { count += 1 }
        }
        print(count)
    }
}
Probe().run()
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", binary + ".swift", "-o", binary]);
    const legacy = join(directory, "legacy");
    const run = owner => Number(execFileSync(binary, [join(directory, "markers"), legacy], { encoding: "utf8", env: { ...process.env, PASEO_BROWSEROS_PERMISSION_OWNER: owner } }).trim());
    assert.equal(run("node"), 2);
    assert.equal(run("node"), 0);
    await mkdir(legacy);
    const legacyOwner = createHash("sha256").update("legacy-host").digest("hex").slice(0, 24);
    for (const permission of ["screen-capture", "accessibility"]) await writeFile(join(legacy, `requested-${legacyOwner}-${permission}`), "");
    assert.equal(run("legacy-host"), 0, "Moving the helper must preserve the once-only prompt record");
    assert.equal((await readdir(join(directory, "markers"))).filter(name => name.startsWith(`requested-${legacyOwner}-`)).length, 2);
    await rm(legacy, { recursive: true });
    assert.equal(run("legacy-host"), 0, "The migrated prompt record survives removal of the old cache");
    assert.equal(run("/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"), 2);
    assert.equal(run("node"), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
