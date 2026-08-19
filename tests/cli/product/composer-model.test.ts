import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/cli/product/config-store.js";
import { ComposerModel } from "../../../src/cli/product/composer-model.js";
import { caps, fakeAdapter, registry } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeEnv(config?: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "conj-composer-"));
  dirs.push(dir);
  const configStore = new ConfigStore(dir);
  if (config !== undefined) {
    await configStore.save(config as never);
  }
  return { dir, configStore };
}

const MODELS = [
  {
    id: "opencode/deepseek-v4-flash-free",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
    label: "Deepseek V4 Flash",
    free: true,
  },
  {
    id: "opencode/mimo-v2.5-free",
    provider: "opencode",
    model: "mimo-v2.5-free",
    label: "Mimo V2.5",
    free: true,
  },
];

function openCodeFreeModels() {
  return Promise.resolve(MODELS);
}

describe("ComposerModel", () => {
  it("first launch picks compatible runtimes and never a paid model silently", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([
      fakeAdapter("opencode", { caps: caps() }),
      fakeAdapter("claude", { caps: caps() }),
      fakeAdapter("codex", { caps: caps() }),
      fakeAdapter("writer-only", {
        caps: caps({ supportsReadOnly: false, supportsStructuredOutput: false }),
      }),
    ]);
    const composer = new ComposerModel(reg, configStore, dir, {
      discoverOpenCode: openCodeFreeModels,
    });
    await composer.init();

    // driver/review need readOnly + structuredOutput — writer-only excluded
    expect(composer.agents.driver.target.runtime).not.toBe("writer-only");
    expect(composer.agents.review.target.runtime).not.toBe("writer-only");
    // worker may be any available runtime
    expect(composer.agents.worker.target.runtime.length).toBeGreaterThan(0);

    // review enabled by default, quality workflow
    expect(composer.agents.review.enabled).toBe(true);
    expect(composer.workflowLabel).toBe("Quality");
  });

  it("Driver filters incompatible runtimes from the runtime picker", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([
      fakeAdapter("opencode", { caps: caps() }),
      fakeAdapter("reader", {
        caps: caps({ supportsReadOnly: true, supportsStructuredOutput: false }),
      }),
    ]);
    const composer = new ComposerModel(reg, configStore, dir);
    await composer.init();
    const options = composer.runtimeOptionsFor("driver");
    const reader = options.find((option) => option.entry.id === "reader");
    expect(reader?.selectable).toBe(false);
    expect(reader?.reason).toContain("structured output");
    expect(options.find((option) => option.entry.id === "opencode")?.selectable).toBe(true);
  });

  it("Review filters incompatible runtimes and Worker accepts them", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([
      fakeAdapter("opencode", { caps: caps() }),
      fakeAdapter("writer-only", {
        caps: caps({ supportsReadOnly: false, supportsStructuredOutput: false }),
      }),
    ]);
    const composer = new ComposerModel(reg, configStore, dir);
    await composer.init();
    expect(
      composer.runtimeOptionsFor("review").find((o) => o.entry.id === "writer-only")?.selectable,
    ).toBe(false);
    expect(
      composer.runtimeOptionsFor("worker").find((o) => o.entry.id === "writer-only")?.selectable,
    ).toBe(true);
  });

  it("selects a model by exact id into ExecutionTarget", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([fakeAdapter("opencode", { caps: caps() })]);
    const composer = new ComposerModel(reg, configStore, dir, {
      discoverOpenCode: openCodeFreeModels,
    });
    await composer.init();
    // drive through the picker: runtime -> model
    composer.openAgentPicker("driver");
    composer.runtimeIndex = 0;
    await composer.pickRuntime();
    expect(composer.modelList.length).toBe(2);
    // pick mimo
    composer.modelIndex = 1;
    composer.pickModel();
    expect(composer.agents.driver.target).toEqual({
      runtime: "opencode",
      model: "opencode/mimo-v2.5-free",
    });
  });

  it("preselects a free model, never a paid one", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([fakeAdapter("opencode", { caps: caps() })]);
    const composer = new ComposerModel(reg, configStore, dir, {
      discoverOpenCode: async () => [
        {
          id: "anthropic/claude-sonnet-5",
          provider: "anthropic",
          model: "claude-sonnet-5",
          label: "Claude Sonnet 5",
        },
        ...MODELS,
      ],
    });
    await composer.init();
    composer.openAgentPicker("worker");
    composer.runtimeIndex = 0;
    await composer.pickRuntime();
    // the preselected index points at the first free model, not the paid one
    expect(composer.modelList[composer.modelIndex]?.id).toBe("opencode/deepseek-v4-flash-free");
  });

  it("restores a persisted config", async () => {
    const { dir, configStore } = await makeEnv({
      version: 1,
      workflow: "single",
      driver: { runtime: "claude", model: "claude/sonnet" },
      worker: { runtime: "opencode", model: "opencode/mimo-v2.5-free" },
      review: { enabled: false, target: { runtime: "claude" } },
      verification: { mode: "custom", command: "pnpm test" },
    });
    const reg = registry([
      fakeAdapter("opencode", { caps: caps() }),
      fakeAdapter("claude", { caps: caps() }),
    ]);
    const composer = new ComposerModel(reg, configStore, dir);
    await composer.init();
    expect(composer.workflowLabel).toBe("Single");
    expect(composer.agents.worker.target.model).toBe("opencode/mimo-v2.5-free");
    expect(composer.agents.review.enabled).toBe(false);
    expect(composer.verificationMode).toBe("custom");
    expect(composer.customCommand).toBe("pnpm test");
    expect(composer.configInvalid).toBe(false);
  });

  it("detects a stored config that is now invalid", async () => {
    const { dir, configStore } = await makeEnv({
      version: 1,
      workflow: "quality",
      driver: { runtime: "gone-runtime", model: "x" },
      worker: { runtime: "opencode" },
      review: { enabled: true, target: { runtime: "opencode" } },
      verification: { mode: "auto" },
    });
    const reg = registry([fakeAdapter("opencode", { caps: caps() })]);
    const composer = new ComposerModel(reg, configStore, dir);
    await composer.init();
    expect(composer.configInvalid).toBe(true);
  });

  it("buildRunOptions produces the exact targets and verification", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([
      fakeAdapter("opencode", { caps: caps() }),
      fakeAdapter("claude", { caps: caps() }),
    ]);
    const composer = new ComposerModel(reg, configStore, dir);
    await composer.init();
    composer.setTask("Create a Todo API", 18);
    composer.agents.driver.target = { runtime: "claude", model: "claude/sonnet" };
    composer.agents.worker.target = { runtime: "opencode", model: "opencode/mimo-v2.5-free" };
    composer.agents.review.target = {
      runtime: "opencode",
      model: "opencode/deepseek-v4-flash-free",
    };
    composer.verificationMode = "custom";
    composer.setCustomCommand("pnpm test", 9);

    const options = composer.buildRunOptions();
    expect(options.workflow).toBe("quality");
    expect(options.brief.content).toBe("Create a Todo API");
    expect(options.workerTarget).toEqual({ runtime: "opencode", model: "opencode/mimo-v2.5-free" });
    expect(options.driverTarget).toEqual({ runtime: "claude", model: "claude/sonnet" });
    expect(options.criticTarget).toEqual({
      runtime: "opencode",
      model: "opencode/deepseek-v4-flash-free",
    });
    expect(options.verifyCommands).toEqual([
      { name: "pnpm test", command: "pnpm", args: ["test"] },
    ]);
    expect(options.correct).toBe(true);
  });

  it("back from the model picker returns to the runtime stage without losing selection", async () => {
    const { dir, configStore } = await makeEnv();
    const reg = registry([fakeAdapter("opencode", { caps: caps() })]);
    const composer = new ComposerModel(reg, configStore, dir, {
      discoverOpenCode: openCodeFreeModels,
    });
    await composer.init();
    composer.openAgentPicker("driver");
    await composer.pickRuntime();
    expect(composer.agentPicker?.stage).toBe("model");
    composer.back();
    expect(composer.agentPicker?.stage).toBe("runtime");
    composer.back();
    expect(composer.agentPicker).toBeUndefined();
  });
});
