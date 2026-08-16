import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DRIVER_DECISION_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  StaticRuntimeRegistry,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentRunInput,
  type AgentRunResult,
  type DriverDecision,
  type Run,
} from "../../src/core/index.js";
import { inlineBrief } from "../../src/cli/brief.js";
import { landCommand } from "../../src/cli/land-command.js";
import { runTask, type WorkerTargetInput } from "../../src/cli/run-command.js";
import type { VerificationCommand } from "../../src/verification/index.js";
import { execGit } from "../../src/workspace/index.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-quality-test-")));
  tempDirs.push(repo);
  await execGit(["init", "-b", "main"], { cwd: repo });
  await execGit(["config", "user.email", "test@conjunction.dev"], { cwd: repo });
  await execGit(["config", "user.name", "Conjunction Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# quality test\n");
  await execGit(["add", "README.md"], { cwd: repo });
  await execGit(["commit", "-m", "initial commit"], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capabilities(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    readOnly: true,
    structuredOutput: true,
    reasoningEffort: ["minimal", "low", "medium", "high", "maximum"],
    ...overrides,
  };
}

function adapter(
  id: string,
  run: (input: AgentRunInput) => Promise<Partial<AgentRunResult>>,
  caps: AgentCapabilities = capabilities(),
): { adapter: AgentAdapter; inputs: AgentRunInput[] } {
  const inputs: AgentRunInput[] = [];
  return {
    inputs,
    adapter: {
      id,
      capabilities: () => caps,
      detect: () => Promise.resolve({ available: true, version: `${id} stub` }),
      run: async (input) => {
        inputs.push(input);
        return { exitCode: 0, timedOut: false, aborted: false, ...(await run(input)) };
      },
    },
  };
}

function driverAdapter(decisions: Array<DriverDecision | string>): {
  adapter: AgentAdapter;
  inputs: AgentRunInput[];
} {
  return adapter("driver", async () => {
    const next = decisions.shift();
    return { lastMessage: typeof next === "string" ? next : JSON.stringify(next) };
  });
}

function criticAdapter(): { adapter: AgentAdapter; inputs: AgentRunInput[] } {
  return adapter("critic", async () => ({
    lastMessage: JSON.stringify({ summary: "critic ok", findings: [] }),
  }));
}

function verifyFile(file: string): VerificationCommand {
  return { name: `test -f ${file}`, command: "test", args: ["-f", file] };
}

async function runQuality(input: {
  decisions: Array<DriverDecision | string>;
  workers: Record<string, (input: AgentRunInput, callIndex: number) => Promise<void>>;
  workerTargets?: readonly WorkerTargetInput[];
  workerCapabilities?: Record<string, AgentCapabilities>;
  verifyCommands?: VerificationCommand[];
  qualityLimits?: { maxDriverDecisions?: number; maxWritableInvocations?: number };
}): Promise<{
  repo: string;
  run: Run;
  driverInputs: AgentRunInput[];
  criticInputs: AgentRunInput[];
  workerInputs: Record<string, AgentRunInput[]>;
  events: { type: string; payload: Record<string, unknown> }[];
  output: string;
}> {
  const repo = await makeTempRepo();
  const driver = driverAdapter(input.decisions);
  const critic = criticAdapter();
  const workerEntries = Object.entries(input.workers).map(([runtime, behavior]) => {
    let calls = 0;
    return adapter(
      runtime,
      async (agentInput) => {
        await behavior(agentInput, calls++);
        return { lastMessage: `${runtime} done` };
      },
      input.workerCapabilities?.[runtime] ?? capabilities(),
    );
  });
  const registry = new StaticRuntimeRegistry([
    driver.adapter,
    critic.adapter,
    ...workerEntries.map((entry) => entry.adapter),
  ]);
  const workerTargets =
    input.workerTargets ??
    ([{ id: "worker", target: { runtime: Object.keys(input.workers)[0] ?? "worker" } }] as const);
  let output = "";
  const result = await runTask(
    {
      brief: inlineBrief("quality task"),
      workflow: "quality",
      workerTarget: workerTargets[0]?.target ?? { runtime: "worker" },
      workerTargets,
      driverTarget: { runtime: "driver" },
      criticTarget: { runtime: "critic" },
      repoPath: repo,
      verifyCommands: input.verifyCommands ?? [verifyFile("done.txt")],
      timeoutMinutes: 1,
      cleanup: false,
      correct: false,
      ...(input.qualityLimits !== undefined ? { qualityLimits: input.qualityLimits } : {}),
    },
    {
      runtimeRegistry: registry,
      out: (chunk) => {
        output += chunk;
      },
    },
  );
  const run = result.run;
  expect(run).toBeDefined();
  const eventsRaw = await readFile(
    path.join(repo, ".conjunction", "runs", `${run?.id}.events.jsonl`),
    "utf8",
  );
  const events = eventsRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  return {
    repo,
    run: run as Run,
    driverInputs: driver.inputs,
    criticInputs: critic.inputs,
    workerInputs: Object.fromEntries(
      workerEntries.map((entry) => [entry.adapter.id, entry.inputs]),
    ),
    events,
    output,
  };
}

describe("quality workflow", () => {
  it("simple: Driver delegates one worker, verifies, accepts, then runs critic", async () => {
    const scenario = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "worker",
          objective: "create done.txt",
          reason: "one worker is enough",
        },
        { action: "verify", reason: "check the file exists" },
        { action: "accept", reason: "fresh green verification" },
      ],
      workers: {
        worker: async (input) => {
          await writeFile(path.join(input.workspacePath, "done.txt"), "ok\n");
        },
      },
    });

    expect(scenario.run.state).toBe("completed");
    expect(scenario.run.attempts).toHaveLength(0);
    expect(scenario.run.driverDecisions?.map((decision) => decision.action)).toEqual([
      "delegate",
      "verify",
      "accept",
    ]);
    expect(scenario.run.invocations?.map((invocation) => invocation.role)).toEqual([
      "driver",
      "worker",
      "driver",
      "driver",
      "critic",
    ]);
    const [driverInvocation, workerInvocation, , acceptInvocation, criticInvocation] =
      scenario.run.invocations ?? [];
    expect(workerInvocation?.parentInvocationId).toBe(driverInvocation?.id);
    expect(criticInvocation?.parentInvocationId).toBe(acceptInvocation?.id);
    expect(scenario.driverInputs.every((input) => input.readOnly === true)).toBe(true);
    expect(
      scenario.driverInputs.every((input) => input.outputSchema === DRIVER_DECISION_SCHEMA),
    ).toBe(true);
    expect(scenario.driverInputs[0]?.instructions).toContain("allowedWorkerTargets");
    expect(scenario.driverInputs[0]?.instructions).toContain("omit reasoningEffort");
    expect(scenario.criticInputs[0]?.target).toEqual({ runtime: "critic" });
    expect(scenario.criticInputs[0]?.readOnly).toBe(true);
    expect(scenario.criticInputs[0]?.outputSchema).toBe(REVIEW_OUTPUT_SCHEMA);
    expect(scenario.run.review?.structured).toBe(true);
    expect(scenario.run.result?.summary).toContain("driver accepted");
    expect(scenario.run.verificationHistory).toHaveLength(2);
  });

  it("dynamic switch: Driver can delegate Worker A, then Worker B, before verifying", async () => {
    const scenario = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "a",
          objective: "start the work",
          reason: "first bounded step",
        },
        {
          action: "delegate",
          targetId: "b",
          objective: "finish the work",
          reason: "worker A stalled; switch target",
          supersedesInvocationId: "previous-worker",
        },
        { action: "verify", reason: "verify final output" },
        { action: "accept", reason: "green after switch" },
      ],
      workerTargets: [
        { id: "a", target: { runtime: "worker-a" } },
        { id: "b", target: { runtime: "worker-b" } },
      ],
      workers: {
        "worker-a": async (input) => {
          await writeFile(path.join(input.workspacePath, "partial.txt"), "partial\n");
        },
        "worker-b": async (input) => {
          await writeFile(path.join(input.workspacePath, "done.txt"), "done\n");
        },
      },
    });

    const workerInvocations =
      scenario.run.invocations?.filter((invocation) => invocation.role === "worker") ?? [];
    expect(workerInvocations.map((invocation) => invocation.target.runtime)).toEqual([
      "worker-a",
      "worker-b",
    ]);
    expect(workerInvocations[0]?.parentInvocationId).toBe(scenario.run.invocations?.[0]?.id);
    expect(workerInvocations[1]?.parentInvocationId).toBe(scenario.run.invocations?.[2]?.id);

    const workerIds = new Set(workerInvocations.map((invocation) => invocation.id));
    expect(
      scenario.events
        .filter(
          (event) =>
            (event.type === "agent.started" || event.type === "agent.completed") &&
            workerIds.has(event.payload.invocationId as string),
        )
        .map((event) => event.type),
    ).toEqual(["agent.started", "agent.completed", "agent.started", "agent.completed"]);
  });

  it("retry and effort escalation are represented as new delegations", async () => {
    const scenario = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "worker",
          objective: "try cheaply",
          reasoningEffort: "low",
          reason: "start low",
        },
        {
          action: "delegate",
          targetId: "worker",
          objective: "retry with more reasoning",
          reasoningEffort: "high",
          reason: "first worker was insufficient",
        },
        { action: "verify", reason: "check retry" },
        { action: "accept", reason: "retry succeeded" },
      ],
      workers: {
        worker: async (input, callIndex) => {
          if (callIndex === 1) {
            await writeFile(path.join(input.workspacePath, "done.txt"), "done\n");
          }
        },
      },
    });

    expect(scenario.workerInputs.worker?.map((input) => input.reasoningEffort)).toEqual([
      "low",
      "high",
    ]);
    expect(
      scenario.run.driverDecisions?.filter((decision) => decision.action === "delegate"),
    ).toHaveLength(2);
    expect(scenario.run.state).toBe("completed");
  });

  it("stale verification: green verify before a later write cannot be accepted", async () => {
    const scenario = await runQuality({
      decisions: [
        { action: "delegate", targetId: "worker", objective: "write v1", reason: "first write" },
        { action: "verify", reason: "green v1" },
        { action: "delegate", targetId: "worker", objective: "write v2", reason: "second write" },
        { action: "accept", reason: "try to accept stale result" },
      ],
      workers: {
        worker: async (input, callIndex) => {
          await writeFile(path.join(input.workspacePath, "done.txt"), `v${callIndex}\n`);
        },
      },
    });

    expect(scenario.run.state).toBe("failed");
    expect(scenario.run.result?.error).toBe("driver accept refused: verification is stale");
  });

  it("red and missing verification are refused mechanically", async () => {
    const red = await runQuality({
      decisions: [
        { action: "delegate", targetId: "worker", objective: "do nothing", reason: "bad worker" },
        { action: "verify", reason: "expect red" },
        { action: "accept", reason: "try red accept" },
      ],
      workers: { worker: async () => {} },
    });
    expect(red.run.state).toBe("failed");
    expect(red.run.result?.error).toBe("driver accept refused: verification is red");
    expect(red.run.verificationHistory?.[0]?.failureSignature).toBe("test -f done.txt:1");

    const missing = await runQuality({
      decisions: [{ action: "accept", reason: "try missing accept" }],
      workers: { worker: async () => {} },
    });
    expect(missing.run.state).toBe("failed");
    expect(missing.run.result?.error).toBe("driver accept refused: verification is missing");
  });

  it("Driver stop and max decisions fail explicitly", async () => {
    const stopped = await runQuality({
      decisions: [{ action: "stop", reason: "not enough evidence" }],
      workers: { worker: async () => {} },
    });
    expect(stopped.run.state).toBe("failed");
    expect(stopped.run.result?.error).toBe("driver stopped: not enough evidence");

    const limited = await runQuality({
      decisions: [
        { action: "delegate", targetId: "worker", objective: "loop", reason: "keep going" },
      ],
      workers: { worker: async () => {} },
      qualityLimits: { maxDriverDecisions: 1 },
    });
    expect(limited.run.state).toBe("failed");
    expect(limited.run.result?.error).toBe("driver decision limit reached (1)");
  });

  it("invalid JSON, unauthorized targets, and incompatible capabilities fail closed", async () => {
    const invalid = await runQuality({
      decisions: [
        '{"action":"delegate","reason":"bad","targetId":"worker","objective":"x","extra":1}',
      ],
      workers: { worker: async () => {} },
    });
    expect(invalid.run.state).toBe("failed");
    expect(invalid.run.result?.error).toContain("invalid driver decision");

    const unauthorized = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "ghost",
          objective: "invent a runtime",
          reason: "bad target",
        },
      ],
      workers: { worker: async () => {} },
    });
    expect(unauthorized.run.state).toBe("failed");
    expect(unauthorized.run.result?.error).toBe('driver selected unauthorized target "ghost"');
    expect(unauthorized.workerInputs.worker).toHaveLength(0);

    const incompatible = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "worker",
          objective: "needs high",
          reasoningEffort: "high",
          reason: "ask unsupported effort",
        },
      ],
      workers: { worker: async () => {} },
      workerCapabilities: { worker: capabilities({ reasoningEffort: ["low"] }) },
    });
    expect(incompatible.run.state).toBe("failed");
    expect(incompatible.run.result?.error).toBe(
      'runtime "worker" does not support reasoning effort "high"',
    );
    expect(incompatible.workerInputs.worker).toHaveLength(0);
  });

  it("E2E deterministic: quality run uses worktree and lands only after completion", async () => {
    const scenario = await runQuality({
      decisions: [
        {
          action: "delegate",
          targetId: "worker",
          objective: "create landed.txt",
          reason: "single file change",
        },
        { action: "verify", reason: "check landed file" },
        { action: "accept", reason: "ready to land" },
      ],
      workers: {
        worker: async (input) => {
          await writeFile(path.join(input.workspacePath, "landed.txt"), "landed\n");
        },
      },
      verifyCommands: [verifyFile("landed.txt")],
    });

    await expect(readFile(path.join(scenario.repo, "landed.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(scenario.run.workspacePath ?? "", "landed.txt"), "utf8")).toBe(
      "landed\n",
    );

    let landOutput = "";
    const code = await landCommand(
      { runId: scenario.run.id, repoPath: scenario.repo, cleanup: false },
      { out: (chunk) => (landOutput += chunk) },
    );
    expect(code).toBe(0);
    expect(landOutput).toContain("Applied");
    expect(await readFile(path.join(scenario.repo, "landed.txt"), "utf8")).toBe("landed\n");

    const stored = JSON.parse(
      await readFile(
        path.join(scenario.repo, ".conjunction", "runs", `${scenario.run.id}.json`),
        "utf8",
      ),
    ) as { run: { landed?: unknown; workflow?: string } };
    expect(stored.run.workflow).toBe("quality");
    expect(stored.run.landed).toBeDefined();
  });
});
