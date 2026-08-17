import { describe, expect, it } from "vitest";

import {
  MAX_CORRECTIONS_PER_RUN,
  Orchestrator,
  StaticRuntimeRegistry,
  RunNotExecutableError,
  transitionRun,
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

/** Adapter that records every input; each call shifts a result from `results`. */
function scriptedAgent(
  results: { exitCode: number | null; timedOut?: boolean; aborted?: boolean }[],
): { adapter: AgentAdapter; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id: "stub-agent",
      capabilities: () => ({
        supportsReadOnly: true,
        supportsStructuredOutput: true,
        reasoningEffort: [],
      }),
      detect: () => Promise.resolve({ available: true }),
      run: (input) => {
        inputs.push(input);
        const result = results.shift() ?? { exitCode: 0 };
        return Promise.resolve({
          exitCode: result.exitCode,
          timedOut: result.timedOut ?? false,
          aborted: result.aborted ?? false,
        });
      },
    },
  };
}

/** Verification runner whose verify() calls shift outcomes from `outcomes`. */
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

const FAIL_TEST: VerificationOutcome = {
  passed: false,
  results: [{ name: "test", exitCode: 1, timedOut: false }],
};
const PASS: VerificationOutcome = {
  passed: true,
  results: [{ name: "test", exitCode: 0, timedOut: false }],
};

function makeOrchestrator(agent: AgentAdapter, verification: VerificationRunner) {
  return new Orchestrator({
    createId,
    now,
    workspace: stubWorkspace,
    runtimeRegistry: new StaticRuntimeRegistry([agent]),
    verification,
  });
}

async function runningRun(orchestrator: Orchestrator) {
  const task = orchestrator.createTask({ title: "t", objective: "do the thing" });
  const run = orchestrator.createRun(task.id, "stub-agent");
  await orchestrator.startRun(run.id);
  return { task, run };
}

const PACKET = "correction packet: fix the failing test";

describe("Orchestrator correction loop (lot 6)", () => {
  it("fail verify -> correction -> pass: run completes with both attempts recorded", async () => {
    const { adapter, inputs } = scriptedAgent([{ exitCode: 0 }, { exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL_TEST, { ...PASS }]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { correction: true });
    expect(run.state).toBe("correcting");
    expect(orchestrator.events.ofType("correction.started")[0]?.payload).toEqual({
      attemptIndex: 2,
      failedCommands: ["test"],
    });

    await orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 1_000 });
    expect(run.state).toBe("correcting"); // still: re-verification decides
    expect(orchestrator.events.ofType("correction.completed")[0]?.payload).toEqual({
      attemptIndex: 2,
      failedCommands: ["test"],
    });

    await orchestrator.verifyRun(run.id, { correction: true });
    expect(run.state).toBe("completed");

    // both attempts recorded, packet stored on the correction attempt
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0]).toMatchObject({ index: 1, agentResult: { exitCode: 0 } });
    expect(run.attempts[1]).toMatchObject({ index: 2, agentResult: { exitCode: 0 } });
    expect(run.attempts[1]?.correctionPacket).toBe(PACKET);
    expect(run.attempts[1]?.startedAt).toBeDefined();
    expect(run.attempts[1]?.completedAt).toBeDefined();

    // the correction attempt received the packet as its prompt override
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.instructions).toContain("do the thing");
    expect(inputs[1]?.instructions).toBe(PACKET);
    expect(run.invocations?.map((invocation) => invocation.role)).toEqual(["worker", "worker"]);
    expect(run.invocations?.[1]?.parentInvocationId).toBe(run.invocations?.[0]?.id);

    expect(orchestrator.events.all().map((e) => e.type)).toEqual([
      "task.created",
      "run.started",
      "workspace.created",
      "invocation.created",
      "invocation.started",
      "agent.started",
      "agent.completed",
      "invocation.completed",
      "verification.started",
      "verification.failed",
      "correction.started",
      "invocation.created",
      "invocation.started",
      "agent.started",
      "agent.completed",
      "invocation.completed",
      "correction.completed",
      "verification.started",
      "verification.passed",
      "run.completed",
    ]);
  });

  it("fail -> correction -> fail: run fails, and the cap forbids any third attempt", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: 0 }]);
    const orchestrator = makeOrchestrator(
      adapter,
      scriptedVerification([FAIL_TEST, { ...FAIL_TEST }]),
    );
    const { task, run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { correction: true });
    await orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 1_000 });
    // correction: true again — the cap must override it
    await orchestrator.verifyRun(run.id, { correction: true });

    expect(run.state).toBe("failed");
    expect(orchestrator.getTask(task.id).status).toBe("failed");
    expect(run.attempts).toHaveLength(2);
    expect(run.result?.error).toBe("verification failed: test");
    expect(MAX_CORRECTIONS_PER_RUN).toBe(1);
    // terminal: no further correction, execution, or verification is possible
    await expect(
      orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 1_000 }),
    ).rejects.toThrow(RunNotExecutableError);
    await expect(orchestrator.verifyRun(run.id)).rejects.toThrow();
  });

  it("without the correction option, a failed verify fails immediately (no correction events)", async () => {
    const { adapter, inputs } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL_TEST]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id); // no correction option

    expect(run.state).toBe("failed");
    expect(inputs).toHaveLength(1);
    expect(orchestrator.events.ofType("correction.started")).toHaveLength(0);
    expect(run.attempts).toHaveLength(1);
  });

  it("executeCorrection requires the correcting state", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await expect(
      orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 1_000 }),
    ).rejects.toThrow(RunNotExecutableError);
  });

  it("executeRun cannot be called twice", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      RunNotExecutableError,
    );
  });

  it("a failing correction agent fails the run (no re-verify possible)", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: 1 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL_TEST, { ...PASS }]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { correction: true });
    await orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 1_000 });

    expect(run.state).toBe("failed");
    expect(run.result?.error).toBe("agent exited with code 1");
    expect(orchestrator.events.ofType("correction.completed")).toHaveLength(0);
  });

  it("a TIMED-OUT correction attempt fails the run", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: null, timedOut: true }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL_TEST, { ...PASS }]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { correction: true });
    await orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 5_000 });

    expect(run.state).toBe("failed");
    expect(run.result?.error).toBe("agent timed out after 5000ms");
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[1]?.agentResult?.timedOut).toBe(true);
  });

  it("an ABORTED correction attempt cancels the run", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }, { exitCode: null, aborted: true }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([FAIL_TEST, { ...PASS }]));
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { correction: true });
    await orchestrator.executeCorrection(run.id, PACKET, { timeoutMs: 5_000 });

    expect(run.state).toBe("cancelled");
    expect(orchestrator.events.ofType("run.cancelled")).toHaveLength(1);
  });

  it("cancelRun is legal from verifying (mid-verification abort)", async () => {
    const { adapter } = scriptedAgent([{ exitCode: 0 }]);
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    transitionRun(run, "verifying", "t");
    orchestrator.cancelRun(run.id, "user abort");
    expect(run.state).toBe("cancelled");
  });
});
