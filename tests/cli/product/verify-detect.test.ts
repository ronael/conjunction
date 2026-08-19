import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { autoDetectVerification } from "../../../src/cli/product/verify-detect.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "conj-verify-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe("autoDetectVerification", () => {
  it("proposes pnpm test from pnpm-lock.yaml + scripts.test", async () => {
    const repo = await tempRepo({
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    });
    const candidates = await autoDetectVerification(repo);
    expect(candidates).toContainEqual({ name: "pnpm test", command: "pnpm", args: ["test"] });
  });

  it("proposes npm test from package-lock.json", async () => {
    const repo = await tempRepo({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ scripts: { test: "mocha" } }),
    });
    const candidates = await autoDetectVerification(repo);
    expect(candidates).toEqual([{ name: "npm test", command: "npm", args: ["test"] }]);
  });

  it("returns empty when there is no package manager signal", async () => {
    const repo = await tempRepo({ "package.json": JSON.stringify({ name: "x" }) });
    expect(await autoDetectVerification(repo)).toEqual([]);
  });

  it("returns empty when there is no package.json", async () => {
    const repo = await tempRepo({ "README.md": "# x" });
    expect(await autoDetectVerification(repo)).toEqual([]);
  });
});
