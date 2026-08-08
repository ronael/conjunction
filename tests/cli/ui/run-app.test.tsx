import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { Run, Task } from "../../../src/core/index.js";
import type { RunTaskResult } from "../../../src/cli/run-command.js";
import { RunApp } from "../../../src/cli/ui/run-app.js";
import { RunModel } from "../../../src/cli/ui/run-model.js";

const noop = () => {};

function makeRun(state: Run["state"]): Run {
  return {
    id: "a1b2c3d4-full-run-id",
    taskId: "task-1",
    runtime: "codex-cli",
    createdAt: "t0",
    state,
    branch: "conjunction/a1b2c3d4",
    workspacePath: "/tmp/repo/.conjunction/worktrees/a1b2c3d4",
  };
}

function makeTask(): Task {
  return {
    id: "task-1",
    title: "add a dark-mode toggle",
    objective: "…",
    constraints: [],
    acceptanceCriteria: [],
    status: "in_progress",
  };
}

function runningModel(): RunModel {
  const model = new RunModel();
  model.setContext({
    run: makeRun("running"),
    task: makeTask(),
    repoRoot: "/tmp/repo",
    storeDir: "/tmp/repo/.conjunction/runs",
  });
  return model;
}

function finalResult(state: Run["state"]): RunTaskResult {
  return {
    exitCode: state === "completed" ? 0 : 1,
    repoRoot: "/tmp/repo",
    storeDir: "/tmp/repo/.conjunction/runs",
    run: makeRun(state),
    task: makeTask(),
    verification: {
      passed: state === "completed",
      results: [
        {
          name: "typecheck",
          command: "pnpm",
          args: [],
          exitCode: state === "completed" ? 0 : 1,
          stdout: "",
          stderr: "",
          durationMs: 1200,
          timedOut: false,
        },
      ],
    },
    cleanupNote: "cleanup:  worktree preserved for inspection",
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("RunApp", () => {
  it("renders the header and streaming agent output while running", async () => {
    const model = runningModel();
    model.appendOutput("thinking…\nwriting hello.txt\n", "stdout");
    model.appendOutput("a warning\n", "stderr");
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Conjunction ─ run a1b2c3d4");
    expect(frame).toContain('task: "add a dark-mode toggle"');
    expect(frame).toContain("RUNNING (agent)");
    expect(frame).toContain("branch conjunction/a1b2c3d4");
    expect(frame).toContain("elapsed 00:");
    expect(frame).toContain("Agent output (autoscroll)");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("writing hello.txt");
    expect(frame).toContain("a warning");
    expect(frame).toContain("q / Ctrl-C: cancel run");
    unmount();
  });

  it("renders verification items: spinner, ✓, ✗ with exit code and stderr tail", async () => {
    const model = runningModel();
    model.verifyItems = [
      { name: "typecheck", status: "pending" },
      { name: "test", status: "pending" },
      { name: "lint", status: "pending" },
    ];
    model.startVerification();
    model.commandStarted({ name: "typecheck", command: "pnpm", args: [] });
    model.commandFinished({
      name: "typecheck",
      command: "pnpm",
      args: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1200,
      timedOut: false,
    });
    model.commandStarted({ name: "test", command: "pnpm", args: [] });
    model.commandFinished({
      name: "test",
      command: "pnpm",
      args: [],
      exitCode: 1,
      stdout: "",
      stderr: "boom: expected true to be false",
      durationMs: 60,
      timedOut: false,
    });
    model.commandStarted({ name: "lint", command: "pnpm", args: [] });

    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("VERIFYING");
    expect(frame).toContain("● typecheck");
    expect(frame).toContain("✓ 1.2s");
    expect(frame).toContain("● test");
    expect(frame).toContain("✗ exit 1");
    expect(frame).toContain("boom: expected true to be false");
    expect(frame).toContain("● lint");
    expect(frame).toContain("running");
    unmount();
  });

  it("renders the COMPLETED final panel with worktree, verify recap and metadata", async () => {
    const model = runningModel();
    model.finish(finalResult("completed"));
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ COMPLETED");
    expect(frame).toContain("branch: conjunction/a1b2c3d4");
    expect(frame).toContain("worktree: /tmp/repo/.conjunction/worktrees/a1b2c3d4");
    expect(frame).toContain("verify: passed (typecheck ✓)");
    expect(frame).toContain("metadata: /tmp/repo/.conjunction/runs/a1b2c3d4-full-run-id.json");
    expect(frame).toContain("q / enter: exit");
    unmount();
  });

  it("renders FAILED and CANCELLED final panels", async () => {
    const failed = runningModel();
    const failedResult = finalResult("failed");
    failedResult.run = { ...failedResult.run!, result: { error: "verification failed: test" } };
    failed.finish(failedResult);
    const failedRender = render(
      <RunApp model={failed} onCancel={noop} onQuit={noop} viewportHeight={6} />,
    );
    await flush();
    const failedFrame = failedRender.lastFrame() ?? "";
    expect(failedFrame).toContain("✗ FAILED");
    expect(failedFrame).toContain("error: verification failed: test");
    failedRender.unmount();

    const cancelled = runningModel();
    cancelled.finish(finalResult("cancelled"));
    const cancelledRender = render(
      <RunApp model={cancelled} onCancel={noop} onQuit={noop} viewportHeight={6} />,
    );
    await flush();
    expect(cancelledRender.lastFrame() ?? "").toContain("■ CANCELLED");
    cancelledRender.unmount();
  });

  it("q cancels while running, q quits when done", async () => {
    const onCancel = vi.fn();
    const onQuit = vi.fn();
    const model = runningModel();
    const { stdin, unmount } = render(
      <RunApp model={model} onCancel={onCancel} onQuit={onQuit} viewportHeight={6} />,
    );
    await flush();
    stdin.write("q");
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onQuit).not.toHaveBeenCalled();

    model.finish(finalResult("completed"));
    await flush();
    stdin.write("q");
    await flush();
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("Ctrl-C cancels while running", async () => {
    const onCancel = vi.fn();
    const model = runningModel();
    const { stdin, unmount } = render(
      <RunApp model={model} onCancel={onCancel} onQuit={noop} viewportHeight={6} />,
    );
    await flush();
    stdin.write("\u0003");
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("arrow keys scroll the output pane and disable/enable follow", async () => {
    const model = runningModel();
    for (let i = 0; i < 20; i++) {
      model.appendOutput(`line-${i}\n`, "stdout");
    }
    const { lastFrame, stdin, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={5} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("line-19");
    expect(lastFrame() ?? "").toContain("(autoscroll)");

    stdin.write("\u001B[A"); // up
    await flush();
    const scrolled = lastFrame() ?? "";
    expect(scrolled).toContain("scrolled 1 ↑");
    expect(scrolled).toContain("line-18");
    expect(scrolled).not.toContain("line-19");

    stdin.write("\u001B[B"); // down, back to the tail
    await flush();
    expect(lastFrame() ?? "").toContain("(autoscroll)");
    expect(lastFrame() ?? "").toContain("line-19");
    unmount();
  });
});
