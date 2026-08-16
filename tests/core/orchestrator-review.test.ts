import { describe, expect, it } from "vitest";

import {
  Orchestrator,
  RunNotExecutableError,
  REVIEW_OUTPUT_SCHEMA,
  StaticRuntimeRegistry,
  UnsupportedRuntimeCapabilityError,
  type AgentAdapter,
  type AgentCapabilities,
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
  capabilities: AgentCapabilities = {
    supportsReadOnly: true,
    supportsStructuredOutput: true,
    reasoningEffort: [],
  },
): { adapter: AgentAdapter; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id: "stub-agent",
      capabilities: () => capabilities,
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

function recordingAgent(
  id: string,
  output: { chunk: string; stream: "stdout" | "stderr" },
): {
  adapter: AgentAdapter;
  inputs: AgentRunInput[];
} {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id,
      capabilities: () => ({
        supportsReadOnly: true,
        supportsStructuredOutput: true,
        reasoningEffort: ["low", "medium", "high", "maximum"],
      }),
      detect: () => Promise.resolve({ available: true }),
      run: (input) => {
        inputs.push(input);
        input.onOutput?.(output.chunk, output.stream);
        return Promise.resolve({
          exitCode: 0,
          timedOut: false,
          aborted: false,
          lastMessage:
            input.readOnly === true
              ? JSON.stringify({ summary: "critic ok", findings: [] })
              : "worker ok",
        });
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
    expect(reviewInput?.instructions).toBe(PACKET);
    expect(run.attempts).toHaveLength(1);
    expect(run.invocations?.map((invocation) => invocation.role)).toEqual(["worker", "critic"]);
    expect(run.invocations?.[1]).toMatchObject({
      parentInvocationId: run.invocations?.[0]?.id,
      readOnly: true,
      state: "completed",
      terminationReason: "completed",
    });

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

  it("resolves worker and critic invocations to distinct runtime targets", async () => {
    const worker = recordingAgent("runtime-a", { chunk: "worker out\n", stream: "stdout" });
    const critic = recordingAgent("runtime-b", { chunk: "critic err\n", stream: "stderr" });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([worker.adapter, critic.adapter]),
      verification: scriptedVerification([PASS]),
    });
    const task = orchestrator.createTask({ title: "t", objective: "do the thing" });
    const run = orchestrator.createRun(
      task.id,
      { runtime: "runtime-a", model: "worker-model" },
      "review",
    );
    await orchestrator.startRun(run.id);

    await orchestrator.executeRun(run.id, {
      timeoutMs: 1_000,
      explicitReasoningEffort: "high",
    });
    await orchestrator.verifyRun(run.id, { review: true });
    await orchestrator.reviewRun(run.id, PACKET, {
      timeoutMs: 1_000,
      target: { runtime: "runtime-b", model: "critic-model" },
      explicitReasoningEffort: "maximum",
    });

    expect(worker.inputs).toHaveLength(1);
    expect(critic.inputs).toHaveLength(1);
    expect(worker.inputs[0]?.target).toEqual({ runtime: "runtime-a", model: "worker-model" });
    expect(worker.inputs[0]?.reasoningEffort).toBe("high");
    expect(critic.inputs[0]?.target).toEqual({ runtime: "runtime-b", model: "critic-model" });
    expect(critic.inputs[0]?.reasoningEffort).toBe("maximum");
    expect(critic.inputs[0]?.readOnly).toBe(true);

    expect(run.invocations).toHaveLength(2);
    expect(run.invocations?.[0]).toMatchObject({
      role: "worker",
      target: { runtime: "runtime-a", model: "worker-model" },
      reasoningEffort: "high",
    });
    expect(run.invocations?.[1]).toMatchObject({
      role: "critic",
      target: { runtime: "runtime-b", model: "critic-model" },
      reasoningEffort: "maximum",
      readOnly: true,
    });

    const [workerInvocation, criticInvocation] = run.invocations ?? [];
    const outputs = orchestrator.events.ofType("agent.output");
    expect(outputs.map((event) => event.payload)).toEqual([
      { invocationId: workerInvocation?.id, stream: "stdout", chunk: "worker out\n" },
      { invocationId: criticInvocation?.id, stream: "stderr", chunk: "critic err\n" },
    ]);
  });

  it("refuses critic read-only execution when the adapter cannot enforce it", async () => {
    const { adapter, inputs } = scriptedAgent(
      [{ exitCode: 0 }, { exitCode: 0, lastMessage: FINDINGS_JSON }],
      { supportsReadOnly: false, supportsStructuredOutput: true, reasoningEffort: [] },
    );
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });

    await expect(orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 })).rejects.toThrow(
      UnsupportedRuntimeCapabilityError,
    );

    expect(inputs).toHaveLength(1);
    expect(run.invocations?.map((invocation) => invocation.role)).toEqual(["worker"]);
    expect(orchestrator.events.ofType("review.started")).toHaveLength(0);
    expect(orchestrator.events.ofType("agent.started")).toHaveLength(1);
    expect(orchestrator.events.ofType("agent.completed")).toHaveLength(1);
  });

  it("refuses critic structured output when the adapter cannot produce it", async () => {
    const { adapter, inputs } = scriptedAgent(
      [{ exitCode: 0 }, { exitCode: 0, lastMessage: FINDINGS_JSON }],
      { supportsReadOnly: true, supportsStructuredOutput: false, reasoningEffort: [] },
    );
    const orchestrator = makeOrchestrator(adapter, scriptedVerification([PASS]));
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    await orchestrator.verifyRun(run.id, { review: true });

    await expect(orchestrator.reviewRun(run.id, PACKET, { timeoutMs: 1_000 })).rejects.toThrow(
      UnsupportedRuntimeCapabilityError,
    );

    expect(inputs).toHaveLength(1);
    expect(run.invocations?.map((invocation) => invocation.role)).toEqual(["worker"]);
    expect(orchestrator.events.ofType("review.started")).toHaveLength(0);
    expect(orchestrator.events.ofType("agent.started")).toHaveLength(1);
    expect(orchestrator.events.ofType("agent.completed")).toHaveLength(1);
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
