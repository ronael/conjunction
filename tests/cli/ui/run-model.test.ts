import { describe, expect, it } from "vitest";

import { MAX_OUTPUT_LINES, RunModel } from "../../../src/cli/ui/run-model.js";

function modelWithContext(): RunModel {
  const model = new RunModel();
  model.setContext({
    run: {
      id: "a1b2c3d4-full-run-id",
      taskId: "task-1",
      runtime: "stub",
      createdAt: "t0",
      state: "running",
      attempts: [],
      branch: "conjunction/a1b2c3d4",
      workspacePath: "/tmp/wt",
    },
    task: {
      id: "task-1",
      title: "add a dark-mode toggle",
      objective: "…",
      constraints: [],
      acceptanceCriteria: [],
      status: "in_progress",
    },
    repoRoot: "/tmp/repo",
    storeDir: "/tmp/repo/.conjunction/runs",
  });
  return model;
}

describe("RunModel output buffering", () => {
  it("splits chunks into lines and merges partial lines across chunks", () => {
    const model = new RunModel();
    model.appendOutput("hel", "stdout");
    model.appendOutput("lo\nwor", "stdout");
    model.appendOutput("ld\n", "stdout");
    expect(model.lines.map((l) => l.text)).toEqual(["hello", "world"]);
  });

  it("tracks the stream of each line", () => {
    const model = new RunModel();
    model.appendOutput("out\n", "stdout");
    model.appendOutput("err\n", "stderr");
    expect(model.lines.map((l) => l.stream)).toEqual(["stdout", "stderr"]);
  });

  it("caps the buffer and counts truncated lines", () => {
    const model = new RunModel();
    for (let i = 0; i < MAX_OUTPUT_LINES + 100; i++) {
      model.appendOutput(`line-${i}\n`, "stdout");
    }
    expect(model.lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(model.truncatedLines).toBe(100);
    expect(model.lines.at(-1)?.text).toBe(`line-${MAX_OUTPUT_LINES + 99}`);
  });
});

describe("RunModel scroll behavior", () => {
  function filledModel(count: number): RunModel {
    const model = new RunModel();
    for (let i = 0; i < count; i++) {
      model.appendOutput(`line-${i}\n`, "stdout");
    }
    return model;
  }

  it("follows the tail by default", () => {
    const model = filledModel(20);
    expect(model.visibleLines(5).map((l) => l.text)).toEqual([
      "line-15",
      "line-16",
      "line-17",
      "line-18",
      "line-19",
    ]);
  });

  it("scrolling up disables follow and shows earlier lines", () => {
    const model = filledModel(20);
    model.scrollUp(3);
    expect(model.follow).toBe(false);
    expect(model.visibleLines(5).map((l) => l.text)).toEqual([
      "line-12",
      "line-13",
      "line-14",
      "line-15",
      "line-16",
    ]);
    // new output does not move the viewport while scrolled
    model.appendOutput("line-20\n", "stdout");
    expect(model.visibleLines(5).at(0)?.text).toBe("line-12");
  });

  it("scrolling back down to the end re-enables follow", () => {
    const model = filledModel(20);
    model.scrollUp(3);
    model.scrollDown(3);
    expect(model.follow).toBe(true);
    model.appendOutput("line-20\n", "stdout");
    expect(model.visibleLines(5).at(-1)?.text).toBe("line-20");
  });
});

describe("RunModel verification items", () => {
  it("tracks pending -> running -> passed/failed with stderr tail on failure", () => {
    const model = modelWithContext();
    model.verifyItems = [
      { name: "typecheck", status: "pending" },
      { name: "test", status: "pending" },
    ];
    model.commandStarted({ name: "typecheck", command: "pnpm", args: [] });
    expect(model.verifyItems[0]?.status).toBe("running");
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
    expect(model.verifyItems[0]).toMatchObject({ status: "passed", exitCode: 0 });

    model.commandStarted({ name: "test", command: "pnpm", args: [] });
    model.commandFinished({
      name: "test",
      command: "pnpm",
      args: [],
      exitCode: 1,
      stdout: "",
      stderr: "line1\nline2\nline3\nline4\nline5\nline6\nline7\n",
      durationMs: 50,
      timedOut: false,
    });
    expect(model.verifyItems[1]?.status).toBe("failed");
    expect(model.verifyItems[1]?.stderrTail).toEqual(["line3", "line4", "line5", "line6", "line7"]);
  });
});

describe("RunModel lifecycle", () => {
  it("moves through phases and records the final result", () => {
    const model = modelWithContext();
    expect(model.phase).toBe("agent");
    model.startVerification();
    expect(model.phase).toBe("verification");
    model.finish({
      exitCode: 0,
      repoRoot: "/tmp/repo",
      storeDir: "/tmp/repo/.conjunction/runs",
      run: {
        id: "a1b2c3d4",
        taskId: "task-1",
        runtime: "stub",
        createdAt: "t0",
        state: "completed",
        attempts: [],
      },
      task: {
        id: "task-1",
        title: "t",
        objective: "o",
        constraints: [],
        acceptanceCriteria: [],
        status: "completed",
      },
    });
    expect(model.phase).toBe("done");
    expect(model.finalState).toBe("completed");
  });
});

describe("RunModel correction phase (lot 6)", () => {
  it("startCorrection switches phase and appends a boundary line to the output", () => {
    const model = modelWithContext();
    model.verifyItems = [{ name: "test", status: "failed", exitCode: 1 }];
    model.startCorrection(["test"]);
    expect(model.phase).toBe("correcting");
    expect(model.lines.at(-1)?.text).toContain("correction attempt 2/2");
    expect(model.lines.at(-1)?.text).toContain("test");
    expect(model.lines.at(-1)?.stream).toBe("system");
  });

  it("startVerification resets all items to pending for the re-check", () => {
    const model = modelWithContext();
    model.verifyItems = [
      { name: "typecheck", status: "passed", exitCode: 0, durationMs: 10 },
      { name: "test", status: "failed", exitCode: 1, stderrTail: ["boom"] },
    ];
    model.startVerification();
    expect(model.phase).toBe("verification");
    expect(model.verifyItems).toEqual([
      { name: "typecheck", status: "pending" },
      { name: "test", status: "pending" },
    ]);
  });
});
