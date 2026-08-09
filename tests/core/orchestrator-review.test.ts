import { describe, expect, it } from "vitest";

import {
  Orchestrator,
  RunNotExecutableError,
  REVIEW_OUTPUT_SCHEMA,
  type AgentAdapter,
  type AgentRunInput,
  type VerificationOutcome,
  type VerificationRunner,
  type WorkspaceProvider,
} from "../../src/core/index.js";

let idCounter = 0;
const createId = () => `id-${++idCounter}`;
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

const stubWorkspace: WorkspaceProvider = {
  createWorkspace: (run) =>
    Promise.resolve({ workspacePath: `/tmp/wt/${run.id}`, branch: `conjunction/${run.id}` }),
};

function scriptedAgent(
  results: {
    exitCode: number | null;
    timedOut?: boolean;
    aborted?: boolean;
    lastMessage?: string;
  }[],
): { adapter: AgentAdapter; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id: "stub-agent",
      detect: () => Promise.resolve({ available: true }),
      run: (input) => {
        inputs.push(input);
        const result = results.shift() ?? { exitCode: 0 };
        const out = {
          exitCode: result.exitCode,
          timedOut: result.timedOut ?? false,
          aborted: result.aborted ?? false,
        };
        return Promise.resolve(
          result.lastMessage !== undefined ? { ...out, lastMessage: result.lastMessage } : out,
        );
      },
    },
  };
}

function scriptedVerification(outcomes: VerificationOutcome[]): VerificationRunner {
  return {
    verify: () => {
      const outcome = outcomes.shift();
      if (!outcome) {
        throw new Error("no scripted verification outcome left");
      }
      return Promise.resolve(outcome);
    },
  };
}

const PASS: VerificationOutcome = {
  passed: true,
  results: [{ name: "test", exitCode: 0, timedOut: false }],
};
const FAIL: VerificationOutcome = {
  passed: false,
  results: [{ name: "test", exitCode: 1, timedOut: false }],
};

const FINDINGS_JSON = JSON.stringify({
  summary: "ok with remarks",
  findings: [
    { severity: "major", path: "src/a.ts", message: "missing edge case" },
    { severity: "nit", message: "naming" },
  ],
});

const PACKET = "reviewer packet: objective + diff + verify summary";

function makeOrchestrator(agent: AgentAdapter, verification: VerificationRunner) {
  return new Orchestrator({ createId, now, workspace: stubWorkspace, agent, verification });
}

async function runningRun(orchestrator: Orchestrator) {
  const task = orchestrator.createTask({ title: "t", objective: "do the thing" });
  const run = orchestrator.createRun(task.id, "stub-agent");
  await orchestrator.startRun(run.id);
  return { task, run };
}

describe("Orchestrator review (lot 7)", () => {
  it("verify pass + review -> completed with structured findings", async () => {
    const { adapter, inputs } = scriptedAgent([
      { exitCode: 0 },
      { exitCode: 0, lastMessage: FINDINGS_JSON },
    ]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    expect(run.state).toBe("reviewing");

    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });
    expect(run.state).toBe("completed");

    // reviewer invocation: read-only, schema, packet override, no extra attempt
    const reviewInput = inputs[1];
    expect(reviewInput?.readOnly).toBe(true);
    expect(reviewInput?.outputSchema).toBe(REVIEW_OUTPUT_SCHEMA);
    expect(reviewInput?.promptOverride).toBe(PACKET);
    expect(run.attempts).toHaveLength(1);

    expect(run.review?.structured).toBe(true);
    expect(run.review?.summary).toBe("ok with remarks");
    expect(run.review?.findings).toHaveLength(2);
    expect(run.review?.error).toBeUndefined();

    expect(orchestrator.events.ofType("review.completed")[0]?.payload).toEqual({
      total: 2,
      critical: 0,
      major: 1,
      minor: 0,
      nit: 1,
      errored: false,
    });
    expect(orchestrator.events.all().map((e) => e.type)).toEqual([
      "task.created",
      "run.started",
      "workspace.created",
      "agent.started",
      "agent.completed",
      "verification.started",
      "verification.passed",
      "review.started",
      "agent.started",
      "agent.completed",
      "review.completed",
      "run.completed",
    ]);
  });

  it("review works without verification commands (vacuous verify)", async () => {
    const { adapter } = scriptedAgent([
      { exitCode: 0 },
      { exitCode: 0, lastMessage: FINDINGS_JSON },
    ]);
    const orchestrator = makeOrchestrator(
      adapter,
      scriptedVerification([{ passed: true, results: [] }]),
    );
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });
    expect(run.state).toBe("completed");
    expect(run.review?.findings).toHaveLength(2);
  });

  it("no review option: verify pass completes without a reviewing state", async () => {
    const { adapter, inputs } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id);
    expect(run.state).toBe("completed");
    expect(run.review).toBeUndefined();
    expect(inputs).toHaveLength(1);
    expect(orchestrator.events.ofType("review.started")).toHaveLength(0);
  });

  it("failed verification means no review, even with review enabled", async () => {
    const { adapter, inputs } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    expect(run.state).toBe("failed");
    expect(inputs).toHaveLength(1);
    await expect(orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 })).rejects.toThrow(
      RunNotExecutableError,
    );
  });

  it("reviewer crash is advisory: run completes with review.error", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: 1 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { task, run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });

    expect(run.state).toBe("completed");
    expect(orchestrator.getTask(task.id).status).toBe("completed");
    expect(run.review?.error).toBe("reviewer exited with code 1");
    expect(run.review?.findings).toEqual([]);
    expect(orchestrator.events.ofType("review.completed")[0]?.payload.errored).toBe(true);
  });

  it("unparseable reviewer output falls back to one unstructured finding", async () => {
    const { adapter } = scriptedAgent([
      { exitCode: 0 },
      { exitCode: 0, lastMessage: "looks fine tbh" },
    ]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });

    expect(run.state).toBe("completed");
    expect(run.review?.structured).toBe(false);
    expect(run.review?.findings).toEqual([{ severity: "major", message: "looks fine tbh" }]);
    expect(run.review?.error).toBeUndefined();
  });

  it("reviewer abort cancels the run", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: null, aborted: true }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });
    expect(run.state).toBe("cancelled");
    expect(run.review).toBeUndefined();
  });

  it("reviewRun cannot run twice (run is terminal after the first)", async () => {
    const { adapter } = scriptedAgent([
      { exitCode: 0 },
      { exitCode: 0, lastMessage: FINDINGS_JSON },
    ]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 });
    expect(run.state).toBe("completed");
    await expect(orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 })).rejects.toThrow(
      RunNotExecutableError,
    );
  });

  it("reviewer timeout is advisory (error recorded, run completes)", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: null, timedOut: true }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 5_000 });
    expect(run.state).toBe("completed");
    expect(run.review?.error).toBe("reviewer timed out after 5000ms");
    expect(orchestrator.events.ofType("review.completed")[0]?.payload.errored).toBe(true);
  });
});
