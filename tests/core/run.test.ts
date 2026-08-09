import { describe, expect, it } from "vitest";

import {
  canTransition,
  InvalidRunStateTransitionError,
  transitionRun,
  type Run,
  type RunState,
} from "../../src/core/index.js";

const ALL_STATES: RunState[] = [
  "pending",
  "running",
  "verifying",
  "correcting",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
];

const ALLOWED: Record<RunState, RunState[]> = {
  pending: ["running", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "failed", "correcting", "reviewing"],
  correcting: ["verifying", "failed", "cancelled"],
  reviewing: ["completed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function makeRun(state: RunState): Run {
  return { id: "run-1", taskId: "task-1", runtime: "stub", createdAt: "t0", state, attempts: [] };
}

describe("run state machine", () => {
  it("walks the happy path pending -> running -> verifying -> completed", () => {
    const run = makeRun("pending");
    transitionRun(run, "running", "t1");
    transitionRun(run, "verifying", "t2");
    transitionRun(run, "completed", "t3");
    expect(run.state).toBe("completed");
    expect(run.startedAt).toBe("t1");
    expect(run.completedAt).toBe("t3");
  });

  it.each(
    ALL_STATES.flatMap((from) =>
      ALL_STATES.filter((to) => !ALLOWED[from].includes(to)).map(
        (to) => [from, to] as [RunState, RunState],
      ),
    ),
  )("rejects invalid transition %s -> %s", (from, to) => {
    const run = makeRun(from);
    expect(() => transitionRun(run, to, "t1")).toThrow(InvalidRunStateTransitionError);
    expect(run.state).toBe(from);
  });

  it.each(
    ALL_STATES.flatMap((from) => ALLOWED[from].map((to) => [from, to] as [RunState, RunState])),
  )("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    const run = makeRun(from);
    transitionRun(run, to, "t1");
    expect(run.state).toBe(to);
  });

  it("terminal states accept no transition", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      for (const to of ALL_STATES) {
        expect(canTransition(state, to)).toBe(false);
      }
    }
  });

  it("sets completedAt only for terminal transitions", () => {
    const run = makeRun("pending");
    transitionRun(run, "running", "t1");
    expect(run.completedAt).toBeUndefined();
    transitionRun(run, "cancelled", "t2");
    expect(run.completedAt).toBe("t2");
  });

  it("walks the correction loop: verifying -> correcting -> verifying -> completed", () => {
    const run = makeRun("verifying");
    transitionRun(run, "correcting", "t1");
    transitionRun(run, "verifying", "t2");
    transitionRun(run, "completed", "t3");
    expect(run.state).toBe("completed");
  });

  it("correcting cannot restart or skip verification (no self-loop, no shortcuts)", () => {
    for (const to of ["correcting", "running", "pending", "completed"] as const) {
      expect(canTransition("correcting", to)).toBe(false);
    }
  });
});
