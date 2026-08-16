import { describe, expect, it } from "vitest";

import {
  MissingDependencyError,
  Orchestrator,
  RunNotExecutableError,
  type AgentAdapter,
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
): {
  adapter: AgentAdapter;
  inputs: AgentRunInput[];
} {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id: "stub-agent",
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
      agent: adapter,
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
      "agent.started",
      "agent.output",
      "agent.output",
      "agent.completed",
    ]);
    const outputs = orchestrator.events.ofType("agent.output");
    expect(outputs.map((e) => [e.payload.stream, e.payload.chunk])).toEqual([
      ["stdout", "working…\n"],
      ["stderr", "warning\n"],
    ]);
    expect(forwarded).toEqual(["working…\n", "warning\n"]);
  });

  it("fails the run on a non-zero agent exit", async () => {
    const { adapter } = stubAgent(() => {}, { exitCode: 1 });
    const orchestrator = new Orchestrator({
      createId,
      now,
      workspace: stubWorkspace,
      agent: adapter,
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
      agent: adapter,
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
      agent: adapter,
    });
    const { run } = await runningRun(orchestrator);
    await orchestrator.executeRun(run.id, { timeoutMs: 5_000 });
    expect(run.state).toBe("cancelled");
    expect(orchestrator.events.ofType("run.cancelled")).toHaveLength(1);
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
      agent: adapter,
    });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub-agent");
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      RunNotExecutableError,
    );
  });

  it("refuses to run an agent without a workspace", async () => {
    const { adapter } = stubAgent(() => {}, {});
    const orchestrator = new Orchestrator({ createId, now, agent: adapter });
    const task = orchestrator.createTask({ title: "t", objective: "o" });
    const run = orchestrator.createRun(task.id, "stub-agent");
    await orchestrator.startRun(run.id); // no workspace provider -> no workspacePath
    await expect(orchestrator.executeRun(run.id, { timeoutMs: 1_000 })).rejects.toThrow(
      /no workspace/,
    );
  });
});
