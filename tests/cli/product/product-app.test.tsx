import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/cli/product/config-store.js";
import { ComposerApp } from "../../../src/cli/product/composer-app.js";
import { ComposerModel } from "../../../src/cli/product/composer-model.js";
import { ResultActionsApp } from "../../../src/cli/product/result-actions-app.js";
import { ResultActionsModel } from "../../../src/cli/product/result-actions-model.js";
import type { RunTaskResult } from "../../../src/cli/run-command.js";
import { caps, fakeAdapter, registry } from "./helpers.js";

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function composer(): Promise<ComposerModel> {
  const reg = registry([
    fakeAdapter("opencode", { caps: caps() }),
    fakeAdapter("claude", { caps: caps() }),
  ]);
  const config = new ConfigStore("/tmp/does-not-matter");
  const model = new ComposerModel(reg, config, "/tmp/repo", {
    discoverOpenCode: async () => [
      {
        id: "opencode/deepseek-v4-flash-free",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
        label: "Deepseek V4 Flash",
        free: true,
      },
    ],
  });
  await model.init();
  return model;
}

describe("ComposerApp render", () => {
  it("renders the task screen with a visible prompt", async () => {
    const model = await composer();
    const { lastFrame, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Conjunction");
    expect(frame).toContain("What should Conjunction do?");
    unmount();
  });

  it("types into the task field and moves to the workflow screen on Enter", async () => {
    const model = await composer();
    const { lastFrame, stdin, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    stdin.write("Create a Todo API");
    await flush();
    expect(model.taskText).toBe("Create a Todo API");
    stdin.write("\r");
    await flush();
    expect(model.screen).toBe("workflow");
    expect(lastFrame() ?? "").toContain("Workflow");
    unmount();
  });

  it("backspace edits the task text", async () => {
    const model = await composer();
    const { stdin, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    stdin.write("hello");
    await flush();
    stdin.write("\u007f"); // backspace
    await flush();
    expect(model.taskText).toBe("hell");
    unmount();
  });

  it("workflow screen shows Quality and Single with the selected blurb", async () => {
    const model = await composer();
    model.screen = "workflow";
    const { lastFrame, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Quality");
    expect(frame).toContain("Single");
    expect(frame).toContain("Driver → Worker → Verify → Review");
    unmount();
  });

  it("agents screen renders each role with its runtime and a single focused row", async () => {
    const model = await composer();
    model.screen = "agents";
    model.agents.driver.target = { runtime: "claude", model: "claude/sonnet" };
    model.agents.worker.target = { runtime: "opencode", model: "opencode/deepseek-v4-flash-free" };
    const { lastFrame, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Driver");
    expect(frame).toContain("claude · sonnet");
    expect(frame).toContain("opencode · deepseek-v4-flash-free");
    expect(frame).toContain("Continue");
    // exactly one focused row
    expect(frame.split("\n").filter((line) => line.trimStart().startsWith("›")).length).toBe(1);
    unmount();
  });

  it("summary screen shows the exact targets and Run option", async () => {
    const model = await composer();
    model.screen = "summary";
    model.taskText = "Create a Todo API";
    model.agents.driver.target = { runtime: "claude", model: "claude/sonnet" };
    model.agents.worker.target = { runtime: "opencode", model: "opencode/mimo-v2.5-free" };
    const { lastFrame, unmount } = render(
      React.createElement(ComposerApp, {
        composer: model,
        width: 60,
        height: 20,
        onExit: () => {},
        tick: 0,
      }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ready to run");
    expect(frame).toContain("Create a Todo API");
    expect(frame).toContain("claude · sonnet");
    expect(frame).toContain("opencode · mimo-v2.5-free");
    expect(frame).toContain("› Run");
    unmount();
  });
});

function completedResult(): RunTaskResult {
  return {
    exitCode: 0,
    repoRoot: "/tmp/repo",
    storeDir: "/tmp/repo/.conjunction/runs",
    run: {
      id: "run-1",
      taskId: "task-1",
      runtime: "opencode",
      workflow: "quality",
      createdAt: "t0",
      state: "completed",
      attempts: [],
      branch: "conjunction/run-1",
      workspacePath: "/tmp/repo/.conjunction/worktrees/run-1",
      baseBranch: "main",
    },
    task: {
      id: "task-1",
      title: "t",
      objective: "o",
      constraints: [],
      acceptanceCriteria: [],
      status: "completed",
    },
    cleanupNote: "preserved",
  };
}

describe("ResultActionsApp render", () => {
  it("shows What next? with Apply/Diff/Report/Keep/Discard", async () => {
    const model = new ResultActionsModel(completedResult(), "/tmp/repo");
    const { lastFrame, unmount } = render(
      React.createElement(ResultActionsApp, { model, width: 60, height: 20, onExit: () => {} }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("What next?");
    expect(frame).toContain("Apply changes");
    expect(frame).toContain("View diff");
    expect(frame).toContain("View report");
    expect(frame).toContain("Keep isolated");
    expect(frame).toContain("Discard changes");
    expect(frame.split("\n").filter((line) => line.trimStart().startsWith("›")).length).toBe(1);
    unmount();
  });

  it("discard confirmation defaults to Cancel", async () => {
    const model = new ResultActionsModel(completedResult(), "/tmp/repo");
    model.openDiscard();
    const { lastFrame, unmount } = render(
      React.createElement(ResultActionsApp, { model, width: 60, height: 20, onExit: () => {} }),
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Discard isolated changes?");
    expect(frame).toContain("› Cancel");
    expect(frame).toContain("Discard & clean up");
    unmount();
  });
});
