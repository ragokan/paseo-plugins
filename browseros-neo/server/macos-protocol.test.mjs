import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopHelper } from "./helper.ts";
import { macHelperSource } from "./macos-source.ts";

test("Swift JSONL preserves Unicode line separators and literal escapes across requests", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-protocol-"));
  const binary = join(directory, "helper");
  let helper;
  try {
    const emitter = macHelperSource.slice(macHelperSource.indexOf("func emit("), macHelperSource.indexOf("\nif CommandLine.arguments"));
    await writeFile(binary + ".swift", "import Foundation\nimport Darwin\n" + emitter + `
while let line = readLine() {
    let request = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
    emit(["id": request["id"]!, "result": request["params"]!])
}
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", binary + ".swift", "-o", binary]);
    helper = new DesktopHelper(0, { executable: binary, args: [] });
    for (const title of ["ordinary title", "a\u2028b\u2029c", "\u2028\u0301", "\u2029\uFE0F", "x\u0301\u2028\u0301y", "literal \\u2028 😀\n\r\"\\"]) {
      assert.deepEqual(await helper.request("echo", { title }), { title });
    }
  } finally { await helper?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("layout shortcuts resolve dead-key glyphs with the UCKeyTranslate option mask", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "browseros-mac-layout-"));
  try {
    // Inspect the installed US layout without switching the user's input source.
    const start = macHelperSource.indexOf("let ansiKeys:");
    const end = macHelperSource.indexOf("func textChunks(", start);
    const functions = macHelperSource.slice(start, end).replace("TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()", "testLayout");
    const binary = join(directory, "layout");
    await writeFile(binary + ".swift", `import Foundation
import Carbon
import ApplicationServices
let layouts = TISCreateInputSourceList([kTISPropertyInputSourceID as String: "com.apple.keylayout.US"] as CFDictionary, true).takeRetainedValue() as! [TISInputSource]
let testLayout = layouts[0]
${functions}
let values = ["a", "A", "´", "¨", "^"].map { characterKey($0).map { [Int($0.0), Int($0.1.rawValue)] } as Any? ?? NSNull() }
print(String(data: try! JSONSerialization.data(withJSONObject: values), encoding: .utf8)!)
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", binary + ".swift", "-o", binary]);
    const result = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
    assert.deepEqual(result, [[0, 0], [0, 1 << 17], [14, 1 << 19], [32, 1 << 19], [22, 1 << 17]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
