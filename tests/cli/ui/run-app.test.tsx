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
    attempts: [],
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
  model.verifyItems = [{ name: "typecheck", status: "pending" }];
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
    cleanupNote: "worktree preserved for inspection",
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("RunApp", () => {
  it("renders the info box, checklist and streaming output while running", async () => {
    const model = runningModel();
    model.appendOutput("thinking…\nwriting hello.txt\n", "stdout");
    model.appendOutput("a warning\n", "stderr");
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    // rounded info box with dim-key/bright-value rows
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
    expect(frame).toContain("Task");
    expect(frame).toContain("add a dark-mode toggle");
    expect(frame).toContain("Branch");
    expect(frame).toContain("conjunction/a1b2c3d4");
    expect(frame).toContain("Worktree");
    expect(frame).toContain("/tmp/repo/.conjunction/worktrees/a1b2c3d4");
    expect(frame).toContain("Verify");
    expect(frame).toContain("typecheck");
    // checklist: workspace done, agent active
    expect(frame).toContain("✓ Workspace ready");
    expect(frame).toContain("Agent (attempt 1)");
    // toned-down output pane label + streamed content
    expect(frame).toContain("── agent output");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("writing hello.txt");
    expect(frame).toContain("a warning");
    // footer
    expect(frame).toContain("elapsed 00:");
    expect(frame).toContain("q / Ctrl-C: cancel");
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
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Verification");
    expect(frame).toContain("✓ typecheck");
    expect(frame).toContain("1.2s");
    expect(frame).toContain("✗ test");
    expect(frame).toContain("exit 1");
    expect(frame).toContain("boom: expected true to be false");
    expect(frame).toContain("lint");
    unmount();
  });

  it("renders the COMPLETED final box with state, verify recap and metadata", async () => {
    const model = runningModel();
    model.finish(finalResult("completed"));
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ COMPLETED");
    expect(frame).toContain("State");
    expect(frame).toContain("conjunction/a1b2c3d4");
    expect(frame).toContain("/tmp/repo/.conjunction/worktrees/a1b2c3d4");
    expect(frame).toContain("passed (typecheck ✓)");
    expect(frame).toContain("/tmp/repo/.conjunction/runs/a1b2c3d4-full-run-id.json");
    expect(frame).toContain("worktree preserved for inspection");
    expect(frame).toContain("q / enter: exit");
    unmount();
  });

  it("renders FAILED and CANCELLED final boxes", async () => {
    const failed = runningModel();
    const failedResult = finalResult("failed");
    failedResult.run = { ...failedResult.run!, result: { error: "verification failed: test" } };
    failed.finish(failedResult);
    const failedRender = render(
      <RunApp model={failed} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();
    const failedFrame = failedRender.lastFrame() ?? "";
    expect(failedFrame).toContain("✗ FAILED");
    expect(failedFrame).toContain("verification failed: test");
    failedRender.unmount();

    const cancelled = runningModel();
    cancelled.finish(finalResult("cancelled"));
    const cancelledRender = render(
      <RunApp model={cancelled} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
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
      <RunApp model={model} onCancel={onCancel} onQuit={onQuit} viewportHeight={6} width={64} />,
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
      <RunApp model={model} onCancel={onCancel} onQuit={noop} viewportHeight={6} width={64} />,
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
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={5} width={64} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("line-19");
    expect(lastFrame() ?? "").not.toContain("scrolled");

    stdin.write("\u001B[A"); // up
    await flush();
    const scrolled = lastFrame() ?? "";
    expect(scrolled).toContain("scrolled 1 ↑");
    expect(scrolled).toContain("line-18");
    expect(scrolled).not.toContain("line-19");

    stdin.write("\u001B[B"); // down, back to the tail
    await flush();
    expect(lastFrame() ?? "").not.toContain("scrolled");
    expect(lastFrame() ?? "").toContain("line-19");
    unmount();
  });

  it("shows a Correction checklist step and resets verification items for the re-check", async () => {
    const model = runningModel();
    model.verifyItems = [{ name: "test", status: "pending" }];
    model.startVerification();
    model.commandStarted({ name: "test", command: "test", args: [] });
    model.commandFinished({
      name: "test",
      command: "test",
      args: [],
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      durationMs: 42,
      timedOut: false,
    });
    model.verificationFinished(false);
    model.startCorrection(["test"]);

    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗ Verification");
    expect(frame).toContain("test failed");
    expect(frame).toContain("Correction (attempt 2)");
    expect(frame).toContain("correction attempt 2/2: fixing failed verification (test)");
    // while correcting, the failed item is still visible…
    expect(frame).toContain("✗ test");

    // …and resets to pending when the re-check starts
    model.startVerification();
    await flush();
    const recheck = lastFrame() ?? "";
    expect(recheck).toContain("Verification (attempt 2)");
    expect(recheck).toContain("• test");
    expect(recheck).not.toContain("✗ test");
    unmount();
  });

  it("final box notes how many attempts ran", async () => {
    const model = runningModel();
    const result = finalResult("completed");
    result.run = {
      ...result.run!,
      attempts: [
        { index: 1, startedAt: "t1", completedAt: "t2" },
        { index: 2, startedAt: "t3", completedAt: "t4", correctionPacket: "…" },
      ],
    };
    model.finish(result);
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("2 (initial + correction)");
    unmount();
  });
});
