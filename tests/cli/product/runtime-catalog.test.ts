import { describe, expect, it } from "vitest";

import {
  buildRuntimeCatalog,
  discoverOpenCodeModels,
  humanizeModel,
} from "../../../src/cli/product/runtime-catalog.js";
import { caps, fakeAdapter, registry } from "./helpers.js";

describe("RuntimeCatalog", () => {
  it("lists runtimes from the registry with capabilities and availability", async () => {
    const reg = registry([
      fakeAdapter("opencode", { caps: caps({ supportsStructuredOutput: true }) }),
      fakeAdapter("claude", { caps: caps() }),
      fakeAdapter("missing", { available: false, reason: "not installed" }),
    ]);
    const catalog = await buildRuntimeCatalog(reg);
    expect(catalog.map((entry) => entry.id)).toEqual(["claude", "missing", "opencode"]);
    const missing = catalog.find((entry) => entry.id === "missing");
    expect(missing?.available).toBe(false);
    expect(missing?.reason).toContain("not installed");
    const opencode = catalog.find((entry) => entry.id === "opencode");
    expect(opencode?.capabilities.supportsStructuredOutput).toBe(true);
    expect(opencode?.discoverModels).toBeDefined();
    const claude = catalog.find((entry) => entry.id === "claude");
    expect(claude?.discoverModels).toBeUndefined();
  });

  it("discoverOpenCodeModels parses `opencode models` output with free tags", async () => {
    const models = await discoverOpenCodeModels(
      "bin",
      async () =>
        "opencode/deepseek-v4-flash-free\nopencode/mimo-v2.5-free\nanthropic/claude-sonnet-4-5\ndeepinfra/deepseek-ai/DeepSeek-V4-Flash\n",
    );
    const deepseek = models.find((model) => model.id === "opencode/deepseek-v4-flash-free");
    expect(deepseek).toMatchObject({ provider: "opencode", free: true });
    expect(deepseek?.label).toBe("Deepseek V4 Flash");
    const anthropic = models.find((model) => model.id === "anthropic/claude-sonnet-4-5");
    expect(anthropic?.free).toBeUndefined();
    expect(anthropic?.label).toBe("Claude Sonnet 4 5");
    const deepinfra = models.find(
      (model) => model.id === "deepinfra/deepseek-ai/DeepSeek-V4-Flash",
    );
    expect(deepinfra?.provider).toBe("deepinfra");
  });

  it("humanizeModel strips -free and humanizes separators", () => {
    expect(humanizeModel("deepseek-v4-flash-free")).toBe("Deepseek V4 Flash");
    expect(humanizeModel("mimo-v2.5-free")).toBe("Mimo V2.5");
    expect(humanizeModel("claude-sonnet-4-5")).toBe("Claude Sonnet 4 5");
  });
});
