import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCli } from "./reopen";

describe("finding the paseo CLI", () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  let root: string | null = null;

  afterEach(() => {
    Object.assign(process.env, saved);
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("finds the CLI in the resources folder beside the app executable", async () => {
    root = mkdtempSync(join(tmpdir(), "zerosub-reopen-"));
    const app = join(root, "Paseo");
    mkdirSync(join(app, "resources", "bin"), { recursive: true });
    writeFileSync(join(app, "paseo"), "");
    writeFileSync(join(app, "resources", "bin", "paseo"), "", { mode: 0o755 });
    process.env.PATH = "";
    process.env.HOME = root;

    expect(await findCli(join(app, "paseo"))).toBe(join(app, "resources", "bin", "paseo"));
  });
});
