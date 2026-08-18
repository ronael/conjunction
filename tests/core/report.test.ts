import { describe, expect, it } from "vitest";

import { buildObserverPacket, buildRunReport, formatRunReport } from "../../src/core/index.js";
import type { Run, Task } from "../../src/core/index.js";

const task: Task = {
  id: "task-1",
  title: "Add deterministic feature",
  objective: "Implement the requested feature and pass checks.",
  constraints: [],
  acceptanceCriteria: [],
  source: { kind: "inline" },
  status: "completed",
};

describe("buildRunReport", () => {
  it("reports invocation permissions from invocation state, not runtime capabilities", () => {
    const run = completedRun();
    const report = buildRunReport({ run, task });

    expect(report.invocations.map((invocation) => invocation.permissions)).toEqual([
      { readOnly: false, workspaceWrite: true },
      { readOnly: false, workspaceWrite: true },
      { readOnly: true, workspaceWrite: false },
      { readOnly: true, workspaceWrite: false },
    ]);
    expect(formatRunReport(report)).toContain("worker codex-cli/gpt-5");
    expect(formatRunReport(report)).toContain("readOnly=false workspaceWrite=true");
  });

  it("aggregates only reliable adapter-provided usage and exposes coverage explicitly", () => {
    const run = completedRun();
    const report = buildRunReport({ run, task });

    expect(report.invocations[0]?.usageKnown).toBe(false);
    expect(report.invocations[1]?.usageKnown).toBe(true);
    expect(report.metrics.usage).toEqual({
      coverage: "partial",
      knownInvocations: 1,
      totalInvocations: 4,
      estimatedCostUsd: 0.028,
      inputTokens: 1200,
      outputTokens: 240,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 50,
    });
  });

  it("counts target switches, effort escalations, verification timings, and evidence coverage", () => {
    const report = buildRunReport({
      run: completedRun(),
      task,
      events: [
        event("run-1", "invocation.created"),
        event("run-1", "invocation.completed"),
        event("run-1", "verification.passed"),
      ],
    });

    expect(report.metrics.durationMs).toBe(6000);
    expect(report.metrics.invocationCount).toBe(4);
    expect(report.metrics.targetSwitches).toBe(1);
    expect(report.metrics.effortEscalations).toBe(1);
    expect(report.metrics.verificationDurationMs).toBe(1500);
    expect(report.acceptanceCoverage.status).toBe("not_demonstrated");
    expect(report.events.types).toMatchObject({
      "invocation.created": 1,
      "invocation.completed": 1,
      "verification.passed": 1,
    });
  });

  it("builds an observer packet from facts without raw transcript requirements", () => {
    const packet = buildObserverPacket(buildRunReport({ run: completedRun(), task }));

    expect(packet).toContain("Structured facts");
    expect(packet).toContain('"workspaceWrite": true');
    expect(packet).toContain('"usageKnown": false');
    expect(packet).not.toContain("agent prompt");
  });

  it("reports usage coverage as unknown when no invocation exposes telemetry", () => {
    const run = completedRun();
    run.invocations = (run.invocations ?? []).map((invocation) => ({
      ...invocation,
      outcome: { exitCode: 0, timedOut: false, aborted: false, summary: "done" },
    }));
    const report = buildRunReport({ run, task });

    expect(report.metrics.usage.coverage).toBe("unknown");
    expect(report.metrics.usage.knownInvocations).toBe(0);
    expect(report.metrics.usage.totalInvocations).toBe(4);
    expect(report.metrics.usage.estimatedCostUsd).toBeNull();
  });

  it("reports usage coverage as complete when every invocation exposes telemetry", () => {
    const run = completedRun();
    run.invocations = (run.invocations ?? []).map((invocation) => ({
      ...invocation,
      outcome: {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        summary: "done",
        usage: { costUsd: 0.01, tokens: { inputTokens: 10, outputTokens: 5 } },
      },
    }));
    const report = buildRunReport({ run, task });

    expect(report.metrics.usage.coverage).toBe("complete");
    expect(report.metrics.usage.knownInvocations).toBe(4);
    expect(report.metrics.usage.totalInvocations).toBe(4);
    expect(report.metrics.usage.estimatedCostUsd).toBeCloseTo(0.04);
  });

  it("reports usage coverage as partial for a mixed known/unknown invocation set", () => {
    const run = completedRun();
    const report = buildRunReport({ run, task });

    expect(report.metrics.usage.coverage).toBe("partial");
    expect(report.metrics.usage.knownInvocations).toBe(1);
    expect(report.metrics.usage.totalInvocations).toBe(4);
    expect(report.metrics.usage.estimatedCostUsd).toBe(0.028);
  });

  it("includes usage coverage in the observer packet", () => {
    const packet = buildObserverPacket(buildRunReport({ run: completedRun(), task }));

    expect(packet).toContain('"coverage": "partial"');
    expect(packet).toContain('"knownInvocations": 1');
    expect(packet).toContain('"totalInvocations": 4');
  });

  it("keeps acceptance coverage not_demonstrated even when verification passes", () => {
    const run = completedRun();
    const report = buildRunReport({ run, task });

    expect(run.verificationResult?.passed).toBe(true);
    expect(report.acceptanceCoverage.status).toBe("not_demonstrated");
    expect(report.acceptanceCoverage.reason).toContain("no explicit mapping");
  });

  it("reports landing status as not_landed and suggests the land command", () => {
    const run = completedRun();
    const report = buildRunReport({ run, task });

    expect(report.landing.status).toBe("not_landed");
    expect(report.landing.landed).toBeUndefined();
    const text = formatRunReport(report);
    expect(text).toContain("workspace isolated");
    expect(text).toContain("conjunction land run-1");
  });

  it("reports landing status as landed and does not suggest landing again", () => {
    const run = completedRun();
    run.landed = {
      landedAt: "2026-01-01T00:01:00.000Z",
      targetBranch: "main",
      targetCommit: "abc123def456",
      patchPath: "/tmp/run-1.landing.patch",
    };
    const report = buildRunReport({ run, task });

    expect(report.landing.status).toBe("landed");
    expect(report.landing.landed).toEqual(run.landed);
    const text = formatRunReport(report);
    expect(text).toContain("landed on main @ abc123de");
    expect(text).not.toContain("conjunction land run-1");
  });
});

function completedRun(): Run {
  return {
    id: "run-1",
    taskId: task.id,
    runtime: "codex-cli",
    workflow: "quality",
    target: { runtime: "codex-cli", model: "gpt-5" },
    state: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:06.000Z",
    attempts: [],
    invocations: [
      {
        id: "inv-worker-1",
        runId: "run-1",
        role: "worker",
        target: { runtime: "codex-cli", model: "gpt-5" },
        reasoningEffort: "low",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        state: "completed",
        terminationReason: "completed",
        outcome: { exitCode: 0, timedOut: false, aborted: false, summary: "done" },
        workspaceChange: { beforeFingerprint: "a", afterFingerprint: "b", changed: true },
      },
      {
        id: "inv-worker-2",
        runId: "run-1",
        role: "worker",
        target: { runtime: "claude-code", model: "sonnet" },
        reasoningEffort: "high",
        createdAt: "2026-01-01T00:00:02.000Z",
        startedAt: "2026-01-01T00:00:02.000Z",
        completedAt: "2026-01-01T00:00:04.000Z",
        state: "completed",
        terminationReason: "completed",
        outcome: {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          summary: "done",
          usage: {
            durationMs: 1900,
            costUsd: 0.028,
            tokens: {
              inputTokens: 1200,
              outputTokens: 240,
              cacheReadInputTokens: 800,
              cacheCreationInputTokens: 50,
            },
          },
        },
        workspaceChange: { beforeFingerprint: "b", afterFingerprint: "c", changed: true },
      },
      {
        id: "inv-driver",
        runId: "run-1",
        role: "driver",
        target: { runtime: "claude-code", model: "opus" },
        reasoningEffort: "maximum",
        createdAt: "2026-01-01T00:00:04.000Z",
        startedAt: "2026-01-01T00:00:04.000Z",
        completedAt: "2026-01-01T00:00:05.000Z",
        state: "completed",
        terminationReason: "completed",
        outcome: { exitCode: 0, timedOut: false, aborted: false, summary: "accept" },
        readOnly: true,
      },
      {
        id: "inv-observer",
        runId: "run-1",
        role: "observer",
        target: { runtime: "claude-code", model: "sonnet" },
        reasoningEffort: "medium",
        createdAt: "2026-01-01T00:00:05.000Z",
        startedAt: "2026-01-01T00:00:05.000Z",
        completedAt: "2026-01-01T00:00:06.000Z",
        state: "completed",
        terminationReason: "completed",
        outcome: { exitCode: 0, timedOut: false, aborted: false, summary: "ok" },
        readOnly: true,
      },
    ],
    verificationResult: { passed: true, results: [] },
    verificationHistory: [
      {
        id: "verify-1",
        startedAt: "2026-01-01T00:00:04.000Z",
        completedAt: "2026-01-01T00:00:05.500Z",
        outcome: { passed: true, results: [] },
        failureSignature: "passed",
        afterInvocationId: "inv-worker-2",
      },
    ],
  };
}

function event(runId: string, type: string) {
  return {
    id: `event-${type}`,
    type,
    runId,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {},
  } as never;
}
