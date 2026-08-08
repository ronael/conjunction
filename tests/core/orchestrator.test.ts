import { describe, expect, it } from "vitest";

import {
  InvalidRunStateTransitionError,
  MissingDependencyError,
  Orchestrator,
  RunNotFoundError,
  type VerificationRunner,
  type WorkspaceProvider,
} from "../../src/core/index.js";

let idCounter = 0;
const createId = () => `id-${++idCounter}`;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

const stubWorkspace: WorkspaceProvider = {
  createWorkspace: (run) =>
    Promise.resolve({
      workspacePath: `/tmp/wt/${run.id}`,
      branch: `conjunction/${run.id}`,
    }),
};

const passingVerification: VerificationRunner = {
  verify: () =>
    Promise.resolve({
      passed: true,
      results: [{ name: "typecheck", exitCode: 0, timedOut: false }],
    }),
};

const failingVerification: VerificationRunner = {
  verify: () =>
    Promise.resolve({
      passed: false,
      results: [
        { name: "typecheck", exitCode: 0, timedOut: false },
        { name: "test", exitCode: 1, timedOut: false },
      ],
    }),
};

function makeOrchestrator(overrides: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  return new Orchestrator({ createId, now, workspace: stubWorkspace, ...overrides });
}

describe("Orchestrator", () => {
  it("drives the happy path: task -> run -> workspace -> verification -> completed", async () => {
    const orchestrator = makeOrchestrator({ verification: passingVerification });
    const task = orchestrator.createTask({ title: "Add dark mode", objective: "Toggle" });
    const run = orchestrator.createRun(task.id, "stub-runtime");

    await orchestrator.startRun(run.id);
    expect(run.state).toBe("running");
    expect(run.workspacePath).toBe(`/tmp/wt/${run.id}`);
    expect(run.branch).toBe(`conjunction/${run.id}`);

    await orchestrator.verifyRun(run.id);
    expect(run.state).toBe("completed");
    expect(run.verificationResult?.passed).toBe(true);
    expect(orchestrator.getTask(task.id).status).toBe("completed");

    expect(orchestrator.events.all().map((e) => e.type)).toEqual([
      "task.created",
      "run.started",
      "workspace.created",
      "verification.started",
      "verification.passed",
      "run.completed",
    ]);
  });

  it("works without a workspace provider (workspace events skipped)", async () => {
    const orchestrator = new Orchestrator({
      createId,
      now,
      verification: passingVerification,
    });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    await orchestrator.startRun(run.id);
    expect(run.workspacePath).toBeUndefined();
    expect(orchestrator.events.all().map((e) => e.type)).toEqual(["task.created", "run.started"]);
    await orchestrator.verifyRun(run.id);
    expect(run.state).toBe("completed");
  });

  it("marks run and task failed when verification fails, with failedCommands", async () => {
    const orchestrator = makeOrchestrator({ verification: failingVerification });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    await orchestrator.startRun(run.id);
    await orchestrator.verifyRun(run.id);

    expect(run.state).toBe("failed");
    expect(run.verificationResult?.passed).toBe(false);
    expect(run.result?.error).toBe("verification failed: test");
    expect(orchestrator.getTask(task.id).status).toBe("failed");

    const failed = orchestrator.events.ofType("verification.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload.failedCommands).toEqual(["test"]);
    expect(orchestrator.events.all().map((e) => e.type)).toContain("run.failed");
  });

  it("enforces the state machine: verifyRun on a pending run throws", async () => {
    const orchestrator = makeOrchestrator({ verification: passingVerification });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    await expect(orchestrator.verifyRun(run.id)).rejects.toThrow(InvalidRunStateTransitionError);
  });

  it("requires a verification runner for verifyRun", async () => {
    const orchestrator = makeOrchestrator();
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    await orchestrator.startRun(run.id);
    await expect(orchestrator.verifyRun(run.id)).rejects.toThrow(MissingDependencyError);
  });

  it("cancels a pending or running run", async () => {
    const orchestrator = makeOrchestrator();
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    orchestrator.cancelRun(run.id, "user abort");
    expect(run.state).toBe("cancelled");
    expect(orchestrator.events.ofType("run.cancelled")[0]?.payload.reason).toBe("user abort");
    // terminal: nothing else is allowed
    await expect(orchestrator.startRun(run.id)).rejects.toThrow(InvalidRunStateTransitionError);
  });

  it("fails a running run explicitly", async () => {
    const orchestrator = makeOrchestrator();
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub");
    await orchestrator.startRun(run.id);
    orchestrator.failRun(run.id, "agent crashed");
    expect(run.state).toBe("failed");
    expect(run.result?.error).toBe("agent crashed");
  });

  it("throws on unknown run ids", () => {
    const orchestrator = makeOrchestrator();
    expect(() => orchestrator.getRun("nope")).toThrow(RunNotFoundError);
  });
});
