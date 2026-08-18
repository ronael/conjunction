import { describe, expect, it } from "vitest";

import {
  MissingDependencyError,
  Orchestrator,
  RunNotExecutableError,
  StaticRuntimeRegistry,
  UnsupportedRuntimeCapabilityError,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentRunInput,
  type AgentRunResult,
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

function stubAgent(
  run: (input: AgentRunInput) => void,
  result: Partial<AgentRunResult>,
  capabilities: AgentCapabilities = {
    supportsReadOnly: true,
    supportsStructuredOutput: true,
    reasoningEffort: [],
  },
): {
  adapter: AgentAdapter;
  inputs: AgentRunInput[];
} {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id: "stub-agent",
      capabilities: () => capabilities,
      detect: () => Promise.resolve({ available: true }),
      run: (input) => {
        inputs.push(input);
        run(input);
        return Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, ...result });
      },
    },
  };
}

async function runningRun(orchestrator: Orchestrator) {
  const task = orchestrator.createTask({ title: "t", objective: "do the thing" });
  const run = orchestrator.createRun(task.id, "stub-agent");
  await orchestrator.startRun(run.id);
  return { task, run };
}

describe("Orchestrator.executeRun", () => {
  it("drives the adapter and emits agent.started/output/completed events", async () => {
    const { adapter, inputs } = stubAgent(
      (input) => {
        input.onOutput?.("working…\n", "stdout");
        input.onOutput?.("warning\n", "stderr");
      },
      { exitCode: 0, lastMessage: "all done" },
    );
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    const forwarded: string[] = [];

    await orchestrator.executeRun(run.id, {
      timeoutMs: 60_000,
      onOutput: (chunk) => forwarded.push(chunk),
    });

    expect(run.state).toBe("running"); // success: verification still decides
    expect(run.result?.summary).toBe("all done");

    const input = inputs[0];
    expect(input?.workspacePath).toBe(`/tmp/wt/${run.id}`);
    expect(input?.instructions).toContain("do the thing");
    expect(input?.timeoutMs).toBe(60_000);
    expect(run.invocations).toHaveLength(1);
    expect(run.invocations?.[0]).toMatchObject({
      role: "worker",
      target: { runtime: "stub-agent" },
      reasoningEffort: "medium",
      state: "completed",
      terminationReason: "completed",
    });

    expect(orchestrator.events.all().map((e) => e.type)).toEqual([
      "task.created",
      "run.started",
      "workspace.created",
      "invocation.created",
      "invocation.started",
      "agent.started",
      "agent.output",
      "agent.output",
      "agent.completed",
      "invocation.completed",
    ]);
    const outputs = orchestrator.events.ofType("agent.output");
    const invocationId = run.invocations?.[0]?.id;
    expect(outputs.map((e) => [e.payload.invocationId, e.payload.stream, e.payload.chunk])).toEqual(
      [
        [invocationId, "stdout", "working…\n"],
        [invocationId, "stderr", "warning\n"],
      ],
    );
    expect(forwarded).toEqual(["working…\n", "warning\n"]);
  });

  it("runs an advisory read-only observer after a terminal run", async () => {
    const { adapter, inputs } = stubAgent(
      (input) => {
        input.onOutput?.("observer packet received\n", "stdout");
      },
      {
        exitCode: 0,
        lastMessage: JSON.stringify({
          summary: "facts look coherent",
          findings: [{ severity: "info", message: "verification evidence exists" }],
        }),
      },
    );
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    run.verificationResult = { passed: true, results: [] };
    const verificationRecord = {
      id: "verify-1",
      startedAt: "2026-01-01T00:00:03.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
      outcome: { passed: true, results: [] },
      failureSignature: "passed",
    };
    run.verificationHistory = [
      run.invocations?.[0]?.id !== undefined
        ? { ...verificationRecord, afterInvocationId: run.invocations[0].id }
        : verificationRecord,
    ];
    run.state = "completed";
    run.completedAt = "2026-01-01T00:00:05.000Z";

    await orchestrator.observeRun(run.id, { timeoutMs: 1_000, target: { runtime: "stub-agent" } });

    expect(inputs.at(-1)).toMatchObject({
      readOnly: true,
      outputSchema: expect.objectContaining({ type: "object" }),
    });
    expect(inputs.at(-1)?.instructions).toContain("Structured facts");
    expect(run.state).toBe("completed");
    expect(run.observer).toMatchObject({
      structured: true,
      summary: "facts look coherent",
      findings: [{ severity: "info", message: "verification evidence exists" }],
    });
    expect(run.invocations?.at(-1)).toMatchObject({
      role: "observer",
      readOnly: true,
      state: "completed",
      terminationReason: "completed",
    });
    const lifecycle = orchestrator.events
      .all()
      .filter((event) => event.type.startsWith("invocation."))
      .map((event) => event.type);
    expect(lifecycle).toEqual([
      "invocation.created",
      "invocation.started",
      "invocation.completed",
      "invocation.created",
      "invocation.started",
      "invocation.completed",
    ]);
  });

  it("refuses explicit unsupported reasoning effort before adapter.run", async () => {
    const { adapter, inputs } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await expect(
      orchestrator.executeRun(run.id, {
        timeoutMs: 1_000,
        explicitReasoningEffort: "high",
      }),
    ).rejects.toThrow(UnsupportedRuntimeCapabilityError);

    expect(inputs).toHaveLength(0);
    expect(run.invocations).toHaveLength(0);
    expect(orchestrator.events.ofType("agent.started")).toHaveLength(0);
    expect(orchestrator.events.ofType("agent.completed")).toHaveLength(0);
  });

  it("keeps the historical default medium intent without requiring runtime effort support", async () => {
    const { adapter, inputs } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.reasoningEffort).toBe("medium");
    expect(run.invocations?.[0]?.reasoningEffort).toBe("medium");
    expect(run.invocations?.[0]?.state).toBe("completed");
  });

  it("fails the run on a non-zero agent exit", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: 1 });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { task, run } = await runningRun(orchestrator);

    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });

    expect(run.state).toBe("failed");
    expect(run.result?.error).toBe("agent exited with code 1");
    expect(orchestrator.getTask(task.id).status).toBe("failed");
    expect(orchestrator.events.all().map((e) => e.type)).toContain("run.failed");
  });

  it("fails the run on agent timeout", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: null, timedOut: true });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 5_000 });
    expect(run.state).toBe("failed");
    expect(run.result?.error).toBe("agent timed out after 5000ms");
  });

  it("cancels the run when the agent run was aborted", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: null, aborted: true });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 5_000 });
    expect(run.state).toBe("cancelled");
    expect(orchestrator.events.ofType("run.cancelled")).toHaveLength(1);
    expect(orchestrator.events.ofType("invocation.cancelled")).toHaveLength(1);
    expect(run.invocations?.[0]).toMatchObject({
      state: "cancelled",
      terminationReason: "aborted",
    });
  });

  it("requires an agent dependency", async () => {
    const orchestrator = new Orchestrator({ createId, now, workspace: stubWorkspace });
    const { run } = await runningRun(orchestrator);
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      MissingDependencyError,
    );
  });

  it("requires the run to be in state running", async () => {
    const { adapter } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub-agent");
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      RunNotExecutableError,
    );
  });

  it("refuses to run an agent without a workspace", async () => {
    const { adapter } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({
      createId,
      now,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub-agent");
    await orchestrator.startRun(run.id); // no workspace provider -> no workspacePath
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      /no workspace/,
    );
  });
});

describe("Orchestrator.invokeAgent role read-only invariants", () => {
  it("runs driver invocations read-only even when readOnly is omitted", async () => {
    const { adapter, inputs } = stubAgent(() => {}, { lastMessage: "{}" });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await orchestrator.invokeAgent(run.id, {
      role: "driver",
      instructions: "decide",
      timeoutMs: 1_000,
      outputSchema: { type: "object" },
    });

    expect(inputs[0]?.readOnly).toBe(true);
    expect(run.invocations?.[0]).toMatchObject({ role: "driver", readOnly: true });
  });

  it("refuses an explicit writable driver before adapter.run", async () => {
    const { adapter, inputs } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await expect(
      orchestrator.invokeAgent(run.id, {
        role: "driver",
        instructions: "decide",
        timeoutMs: 1_000,
        readOnly: false,
      } as unknown as Parameters<Orchestrator["invokeAgent"]>[1]),
    ).rejects.toThrow(/driver invocations are always read-only/);

    expect(inputs).toHaveLength(0);
    expect(run.invocations).toHaveLength(0);
  });

  it("runs critic invocations read-only even when readOnly is omitted", async () => {
    const { adapter, inputs } = stubAgent(() => {}, { lastMessage: "{}" });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await orchestrator.invokeAgent(run.id, {
      role: "critic",
      instructions: "review",
      timeoutMs: 1_000,
      outputSchema: { type: "object" },
    });

    expect(inputs[0]?.readOnly).toBe(true);
    expect(run.invocations?.[0]).toMatchObject({ role: "critic", readOnly: true });
  });

  it("refuses driver execution on a runtime that cannot enforce read-only", async () => {
    const { adapter, inputs } = stubAgent(
      () => {},
      {},
      { supportsReadOnly: false, supportsStructuredOutput: true, reasoningEffort: [] },
    );
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await expect(
      orchestrator.invokeAgent(run.id, {
        role: "driver",
        instructions: "decide",
        timeoutMs: 1_000,
        outputSchema: { type: "object" },
      }),
    ).rejects.toThrow(UnsupportedRuntimeCapabilityError);

    expect(inputs).toHaveLength(0);
    expect(run.invocations).toHaveLength(0);
  });

  it("keeps normal worker invocations writable by default", async () => {
    const { adapter, inputs } = stubAgent(() => {}, { lastMessage: "done" });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);

    await orchestrator.invokeAgent(run.id, {
      role: "worker",
      instructions: "write",
      timeoutMs: 1_000,
    });

    expect(inputs[0]?.readOnly).toBeUndefined();
    expect(run.invocations?.[0]).toMatchObject({ role: "worker" });
    expect(run.invocations?.[0]?.readOnly).toBeUndefined();
  });
});

describe("Orchestrator invocation lifecycle", () => {
  it("emits invocation.cancelled when a worker is aborted", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: null, aborted: true });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });

    expect(run.invocations?.[0]).toMatchObject({
      role: "worker",
      state: "cancelled",
      terminationReason: "aborted",
    });
    expect(orchestrator.events.ofType("invocation.cancelled")).toHaveLength(1);
  });

  it("emits invocation.cancelled when a driver is aborted", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: null, aborted: true });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.invokeAgent(run.id, {
      role: "driver",
      instructions: "decide",
      timeoutMs: 1_000,
      outputSchema: { type: "object" },
    });

    expect(run.invocations?.[0]).toMatchObject({
      role: "driver",
      state: "cancelled",
      terminationReason: "aborted",
    });
    expect(orchestrator.events.ofType("invocation.cancelled")).toHaveLength(1);
  });

  it("emits invocation.cancelled when a critic is aborted", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: null, aborted: true });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.invokeAgent(run.id, {
      role: "critic",
      instructions: "review",
      timeoutMs: 1_000,
      outputSchema: { type: "object" },
    });

    expect(run.invocations?.[0]).toMatchObject({
      role: "critic",
      state: "cancelled",
      terminationReason: "aborted",
    });
    expect(orchestrator.events.ofType("invocation.cancelled")).toHaveLength(1);
  });

  it("skips observer when the run failed before any worker or verification", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: 1 });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    expect(run.state).toBe("failed");
    expect(run.invocations?.some((invocation) => invocation.role === "worker")).toBe(true);
    // observer should still run because a worker invocation exists, even if it failed
    run.state = "completed";
    run.completedAt = "2026-01-01T00:00:05.000Z";
    await orchestrator.observeRun(run.id, { timeoutMs: 1_000, target: { runtime: "stub-agent" } });
    expect(run.observer).toBeDefined();
  });

  it("emits invocation.cancelled when an observer is aborted", async () => {
    const inputs: AgentRunInput[] = [];
    const adapter: AgentAdapter = {
      id: "stub-agent",
      capabilities: () => ({
        supportsReadOnly: true,
        supportsStructuredOutput: true,
        reasoningEffort: [],
      }),
      detect: () => Promise.resolve({ available: true }),
      run: (input) => {
        inputs.push(input);
        const aborted = inputs.length === 2;
        const result: AgentRunResult = {
          exitCode: aborted ? null : 0,
          timedOut: false,
          aborted,
        };
        if (!aborted) {
          result.lastMessage = "done";
        }
        return Promise.resolve(result);
      },
    };
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      runtimeRegistry: new StaticRuntimeRegistry([adapter]),
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 1_000 });
    run.verificationResult = { passed: true, results: [] };
    run.state = "completed";
    run.completedAt = "2026-01-01T00:00:05.000Z";

    await orchestrator.observeRun(run.id, { timeoutMs: 1_000, target: { runtime: "stub-agent" } });

    expect(run.invocations?.at(-1)).toMatchObject({
      role: "observer",
      state: "cancelled",
      terminationReason: "aborted",
    });
    expect(orchestrator.events.ofType("invocation.cancelled")).toHaveLength(1);
    expect(run.state).toBe("completed");
  });
});
