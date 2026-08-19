import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/cli/product/config-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(): Promise<{ store: ConfigStore; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "conj-config-"));
  dirs.push(dir);
  return { store: new ConfigStore(dir), dir };
}

describe("ConfigStore", () => {
  it("returns undefined when no config exists", async () => {
    const { store } = await tempStore();
    expect(await store.load()).toBeUndefined();
  });

  it("round-trips a config", async () => {
    const { store } = await tempStore();
    const config = {
      version: 1 as const,
      workflow: "quality" as const,
      driver: { runtime: "claude", model: "claude/sonnet" },
      worker: { runtime: "opencode", model: "opencode/mimo-v2.5-free" },
      review: { enabled: true, target: { runtime: "codex" } },
      verification: { mode: "custom" as const, command: "pnpm test" },
    };
    await store.save(config);
    expect(await store.load()).toEqual(config);
  });

  it("treats corrupt config as absent", async () => {
    const { store, dir } = await tempStore();
    await writeFile(path.join(dir, "config.json"), "{ not json", "utf8");
    expect(await store.load()).toBeUndefined();
  });

  it("treats an unknown version as absent", async () => {
    const { store, dir } = await tempStore();
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ version: 99 }), "utf8");
    expect(await store.load()).toBeUndefined();
  });

  it("skips missing review/verification gracefully", async () => {
    const { store } = await tempStore();
    const config = {
      version: 1 as const,
      workflow: "single" as const,
      driver: { runtime: "claude" },
      worker: { runtime: "opencode", model: "opencode/deepseek-v4-flash-free" },
      review: { enabled: false, target: { runtime: "claude" } },
      verification: { mode: "none" as const },
    };
    await store.save(config);
    const loaded = await store.load();
    expect(loaded?.verification).toEqual({ mode: "none" });
    expect(loaded?.review.enabled).toBe(false);
  });
});
