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
  it("renders the header, task, checklist and compact streaming output while running", async () => {
    const model = runningModel();
    model.appendOutput("thinking…\nwriting hello.txt\n", "stdout");
    model.appendOutput("a warning\n", "stderr");
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();

    const frame = lastFrame() ?? "";
    // header + task at top, workspace line compact
    expect(frame).toContain("Conjunction");
    expect(frame).toContain("add a dark-mode toggle");
    expect(frame).toContain("workspace · isolated · conjunction/a1b2c3d4");
    // checklist: workspace done, agent active
    expect(frame).toContain("✓ Workspace ready");
    expect(frame).toContain("Agent (attempt 1)");
    // compact output pane label + streamed content
    expect(frame).toContain("── agent output");
    expect(frame).toContain("thinking…");
    expect(frame).toContain("writing hello.txt");
    expect(frame).toContain("a warning");
    // footer
    expect(frame).toContain("elapsed 00:");
    expect(frame).toContain("q / Ctrl-C: cancel");
    unmount();
  });

  it("does not reserve an empty output viewport when there is no agent output", async () => {
    const model = runningModel();
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("agent output");
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

  it("renders the Review checklist step and findings in the final box", async () => {
    const model = runningModel();
    model.startReview();
    {
      const { lastFrame, unmount } = render(
        <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
      );
      await flush();
      expect(lastFrame() ?? "").toContain("Review");
      unmount();
    }

    const findings = Array.from({ length: 7 }, (_, i) => ({
      severity: (i === 0 ? "critical" : i === 1 ? "major" : "nit") as "critical" | "major" | "nit",
      message: `finding ${i}`,
      ...(i === 0 ? { path: "src/a.ts" } : {}),
    }));
    model.finishReview({
      summary: "…",
      findings,
      structured: true,
      completedAt: "t2",
      agentResult: { exitCode: 0, timedOut: false, aborted: false },
    });
    const result = finalResult("completed");
    result.run = {
      ...result.run!,
      review: {
        summary: "…",
        findings,
        structured: true,
        completedAt: "t2",
        agentResult: { exitCode: 0, timedOut: false, aborted: false },
      },
    };
    model.finish(result);

    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={64} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ Review");
    expect(frame).toContain("7 findings (1 critical, 1 major, 5 nit)");
    expect(frame).toContain("[critical]");
    expect(frame).toContain("src/a.ts: finding 0");
    expect(frame).toContain("finding 4");
    expect(frame).not.toContain("finding 5"); // capped at 5
    expect(frame).toContain("+2 more in the run JSON");
    unmount();
  });

  function qualityModel(): RunModel {
    const model = new RunModel();
    model.verifyItems = [{ name: "grep", status: "pending" }];
    model.setContext({
      run: {
        id: "a1b2c3d4-full-run-id",
        taskId: "task-1",
        runtime: "opencode",
        target: { runtime: "opencode", model: "opencode/deepseek-v4-flash-free" },
        workflow: "quality",
        createdAt: "t0",
        state: "running",
        attempts: [],
        branch: "conjunction/a1b2c3d4",
        workspacePath: "/tmp/repo/.conjunction/worktrees/a1b2c3d4",
      },
      task: makeTask(),
      repoRoot: "/tmp/repo",
      storeDir: "/tmp/repo/.conjunction/runs",
    });
    return model;
  }

  it("renders a Driver delegate decision with reason and bounded objective", async () => {
    const model = qualityModel();
    model.driverStarted();
    model.driverDecision({
      id: "d1",
      invocationId: "i1",
      createdAt: "t",
      action: "delegate",
      targetId: "worker",
      objective: "Implement the requested file.",
      reason: "The requested file does not exist yet.",
    } as never);
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Driver #1 · opencode / deepseek-v4-flash-free");
    expect(frame).toContain("→ Delegate · worker");
    expect(frame).toContain("The requested file does not exist yet.");
    expect(frame).toContain("Implement the requested file.");
    unmount();
  });

  it("renders Driver verify and accept decisions, and a refused accept", async () => {
    const model = qualityModel();
    model.driverStarted();
    model.driverDecision({
      id: "d1",
      invocationId: "i1",
      createdAt: "t",
      action: "verify",
      reason: "The implementation is ready for deterministic verification.",
    } as never);
    {
      const { lastFrame, unmount } = render(
        <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
      );
      await flush();
      expect(lastFrame() ?? "").toContain("→ Verify");
      unmount();
    }
    model.driverStarted();
    const accept = {
      id: "d2",
      invocationId: "i2",
      createdAt: "t",
      action: "accept",
      reason: "green",
    } as never;
    model.driverDecision(accept);
    model.driverDecisionRefused(accept as never, "verification is missing");
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("→ Accept");
    expect(frame).toContain("✗ Refused · verification is missing");
    unmount();
  });

  it("shows live Worker activity under the active step", async () => {
    const model = qualityModel();
    model.driverStarted();
    model.driverDecision({
      id: "d1",
      invocationId: "i1",
      createdAt: "t",
      action: "delegate",
      targetId: "worker",
      objective: "create the file",
      reason: "go",
    } as never);
    model.agentActivity({ kind: "editing", label: "Editing", detail: "ui-test.txt" });
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Editing ui-test.txt");
    expect(frame).toContain("Worker #1 · opencode / deepseek-v4-flash-free");
    unmount();
  });

  it("keeps exactly one active step (one spinner) and clears it on completion", async () => {
    const model = qualityModel();
    model.driverStarted();
    const { lastFrame: f1, unmount: u1 } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
    );
    await flush();
    const activeSteps = (f1() ?? "").split("\n").filter((l) => /^[◐◓◑◒] /.test(l));
    expect(activeSteps).toHaveLength(1);
    u1();

    model.driverDecision({
      id: "d1",
      invocationId: "i1",
      createdAt: "t",
      action: "stop",
      reason: "nope",
    } as never);
    model.finish({
      exitCode: 1,
      repoRoot: "/tmp/repo",
      storeDir: "/tmp/repo/.conjunction/runs",
      run: { ...makeRun("failed"), driverDecisions: [] } as never,
      task: makeTask(),
    } as never);
    const { lastFrame, unmount } = render(
      <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
    );
    await flush();
    expect(lastFrame() ?? "").not.toMatch(/^[◐◓◑◒] /m);
    unmount();
  });

  it("clears the spinner on failed and cancelled final states", async () => {
    for (const state of ["failed", "cancelled"] as const) {
      const model = new RunModel();
      model.setContext({
        run: { ...makeRun("running"), workflow: "single" } as never,
        task: makeTask(),
        repoRoot: "/tmp/repo",
        storeDir: "/tmp/repo/.conjunction/runs",
      });
      model.finish(finalResult(state));
      const { lastFrame, unmount } = render(
        <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={60} />,
      );
      await flush();
      const frame = lastFrame() ?? "";
      expect(frame).not.toMatch(/^[◐◓◑◒] /m);
      if (state === "failed") {
        expect(frame).toContain("✗ FAILED");
      } else {
        expect(frame).toContain("■ CANCELLED");
      }
      unmount();
    }
  });

  it("wraps long paths and reasons without exploding the layout at narrow widths", async () => {
    const model = new RunModel();
    model.verifyItems = [];
    model.setContext({
      run: {
        id: "a1b2c3d4-full-run-id",
        taskId: "task-1",
        runtime: "opencode",
        workflow: "single",
        createdAt: "t0",
        state: "running",
        attempts: [],
        branch: "conjunction/a1b2c3d4",
        workspacePath:
          "/Users/someone/a/really/deep/and/long/workspace/path/.conjunction/worktrees/a1b2c3d4",
      },
      task: makeTask(),
      repoRoot: "/tmp/repo",
      storeDir: "/tmp/repo/.conjunction/runs",
    });
    model.appendOutput("some\noutput\nlines\nhere\n", "stdout");
    for (const w of [80, 60, 40]) {
      const { lastFrame, unmount } = render(
        <RunApp model={model} onCancel={noop} onQuit={noop} viewportHeight={6} width={w} />,
      );
      await flush();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("add a dark-mode toggle");
      expect(frame).toContain("some");
      // no single unbreakable line exceeds the width (long path wraps)
      for (const line of frame.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(w + 2);
      }
      unmount();
    }
  });
});
