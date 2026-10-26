import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { macHelperSource } from "./macos-source.ts";

test("permission requests happen once per permission and host, surviving helper restarts", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-permissions-"));
  try {
    const start = macHelperSource.indexOf("    private func requestOnce(");
    const end = macHelperSource.indexOf("    private func permissions()", start);
    const requestOnce = macHelperSource.slice(start, end);
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
    const run = owner => Number(execFileSync(binary, [join(directory, "markers")], { encoding: "utf8", env: { ...process.env, PASEO_BROWSEROS_PERMISSION_OWNER: owner } }).trim());
    assert.equal(run("node"), 2);
    assert.equal(run("node"), 0);
    assert.equal(run("/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"), 2);
    assert.equal(run("node"), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
