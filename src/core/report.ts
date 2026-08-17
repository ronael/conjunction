import type { ConjunctionEvent } from "./events.js";
import type { Invocation, ReasoningEffort } from "./invocation.js";
import type { Run, VerificationRecord } from "./run.js";
import type { Task } from "./task.js";

export interface RunReport {
  runId: string;
  task: { id: string; title: string; source?: Task["source"] };
  outcome: {
    state: Run["state"];
    result?: Run["result"];
    startedAt?: string;
    completedAt?: string;
  };
  metrics: RunMetrics;
  invocations: InvocationReport[];
  verification: VerificationReport;
  review?: {
    structured: boolean;
    findings: number;
    critical: number;
    major: number;
    minor: number;
    nit: number;
    error?: string;
  };
  observer?: {
    structured: boolean;
    findings: number;
    error?: string;
  };
  acceptanceCoverage: {
    status: "demonstrated" | "failed" | "not_demonstrated";
    reason: string;
  };
  warnings: string[];
  events: { count: number; types: Record<string, number> };
}

export interface RunMetrics {
  durationMs: number | null;
  invocationCount: number;
  attemptCount: number;
  correctionCount: number;
  targetSwitches: number;
  effortEscalations: number;
  verificationDurationMs: number | null;
  usage: {
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
  };
}

export interface InvocationReport {
  id: string;
  role: Invocation["role"];
  runtime: string;
  model?: string;
  reasoningEffort: ReasoningEffort;
  parentInvocationId?: string;
  state: Invocation["state"];
  terminationReason?: Invocation["terminationReason"];
  durationMs: number | null;
  permissions: {
    readOnly: boolean;
    workspaceWrite: boolean;
  };
  workspaceChanged?: boolean;
  usageKnown: boolean;
  usage?: NonNullable<Invocation["outcome"]>["usage"];
}

export interface VerificationReport {
  latestPassed: boolean | null;
  historyCount: number;
  records: {
    id: string;
    passed: boolean;
    durationMs: number | null;
    failureSignature: string;
    afterInvocationId?: string;
  }[];
}

const EFFORT_ORDER: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  maximum: 4,
};

export function buildRunReport(input: {
  run: Run;
  task: Task;
  events?: readonly ConjunctionEvent[];
}): RunReport {
  const invocations = (input.run.invocations ?? []).map(invocationReport);
  const verificationRecords = input.run.verificationHistory ?? [];
  const verificationDurationMs = sumKnown(verificationRecords.map(recordDuration));
  const usage = aggregateUsage(input.run.invocations ?? []);
  const events = input.events ?? [];
  const eventTypes: Record<string, number> = {};
  for (const event of events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  }
  const reviewFindings = input.run.review?.findings ?? [];
  const warnings = reportWarnings(input.run, invocations, verificationRecords);
  return {
    runId: input.run.id,
    task: {
      id: input.task.id,
      title: input.task.title,
      ...(input.task.source !== undefined ? { source: input.task.source } : {}),
    },
    outcome: {
      state: input.run.state,
      ...(input.run.result !== undefined ? { result: input.run.result } : {}),
      ...(input.run.startedAt !== undefined ? { startedAt: input.run.startedAt } : {}),
      ...(input.run.completedAt !== undefined ? { completedAt: input.run.completedAt } : {}),
    },
    metrics: {
      durationMs: duration(input.run.startedAt, input.run.completedAt),
      invocationCount: invocations.length,
      attemptCount: input.run.attempts.length,
      correctionCount: input.run.attempts.filter(
        (attempt) => attempt.correctionPacket !== undefined,
      ).length,
      targetSwitches: countTargetSwitches(input.run.invocations ?? []),
      effortEscalations: countEffortEscalations(input.run.invocations ?? []),
      verificationDurationMs,
      usage,
    },
    invocations,
    verification: {
      latestPassed: input.run.verificationResult?.passed ?? null,
      historyCount: verificationRecords.length,
      records: verificationRecords.map((record) => ({
        id: record.id,
        passed: record.outcome.passed,
        durationMs: recordDuration(record),
        failureSignature: record.failureSignature,
        ...(record.afterInvocationId !== undefined
          ? { afterInvocationId: record.afterInvocationId }
          : {}),
      })),
    },
    ...(input.run.review !== undefined
      ? {
          review: {
            structured: input.run.review.structured,
            findings: reviewFindings.length,
            critical: reviewFindings.filter((finding) => finding.severity === "critical").length,
            major: reviewFindings.filter((finding) => finding.severity === "major").length,
            minor: reviewFindings.filter((finding) => finding.severity === "minor").length,
            nit: reviewFindings.filter((finding) => finding.severity === "nit").length,
            ...(input.run.review.error !== undefined ? { error: input.run.review.error } : {}),
          },
        }
      : {}),
    ...(input.run.observer !== undefined
      ? {
          observer: {
            structured: input.run.observer.structured,
            findings: input.run.observer.findings.length,
            ...(input.run.observer.error !== undefined ? { error: input.run.observer.error } : {}),
          },
        }
      : {}),
    acceptanceCoverage: acceptanceCoverage(input.run),
    warnings,
    events: { count: events.length, types: eventTypes },
  };
}

export function formatRunReport(report: RunReport): string {
  const lines = [
    `Run #${report.runId}`,
    "",
    "Outcome",
    `${report.outcome.state === "completed" ? "✓" : "•"} ${report.outcome.state}`,
    `${report.verification.latestPassed === null ? "• verification unknown" : report.verification.latestPassed ? "✓ verification passed" : "✗ verification failed"}`,
    `${coverageSymbol(report.acceptanceCoverage.status)} acceptance ${report.acceptanceCoverage.status.replace("_", " ")}`,
    "",
    "Duration",
    `total              ${formatMs(report.metrics.durationMs)}`,
    `verification       ${formatMs(report.metrics.verificationDurationMs)}`,
    "",
    "Usage",
    `tokens in          ${formatNullable(report.metrics.usage.inputTokens)}`,
    `tokens out         ${formatNullable(report.metrics.usage.outputTokens)}`,
    `cost USD           ${formatNullable(report.metrics.usage.costUsd)}`,
    "",
    "Invocations",
    `${report.metrics.invocationCount} total, ${report.metrics.targetSwitches} target switch(es), ${report.metrics.effortEscalations} effort escalation(s)`,
  ];
  for (const invocation of report.invocations) {
    lines.push(
      `- ${invocation.role} ${invocation.runtime}${invocation.model ? `/${invocation.model}` : ""} ${formatMs(invocation.durationMs)} readOnly=${invocation.permissions.readOnly} workspaceWrite=${invocation.permissions.workspaceWrite} usage=${invocation.usageKnown ? "known" : "unknown"}`,
    );
  }
  lines.push("", "Verification");
  for (const record of report.verification.records) {
    lines.push(
      `- ${record.failureSignature} ${record.passed ? "PASS" : "FAIL"} ${formatMs(record.durationMs)}`,
    );
  }
  if (report.review !== undefined) {
    lines.push("", "Review", `${report.review.findings} finding(s)`);
  }
  if (report.observer !== undefined) {
    lines.push("", "Observer", `${report.observer.findings} finding(s)`);
  }
  lines.push("", "Warnings");
  if (report.warnings.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

function invocationReport(invocation: Invocation): InvocationReport {
  return {
    id: invocation.id,
    role: invocation.role,
    runtime: invocation.target.runtime,
    ...(invocation.target.model !== undefined ? { model: invocation.target.model } : {}),
    reasoningEffort: invocation.reasoningEffort,
    ...(invocation.parentInvocationId !== undefined
      ? { parentInvocationId: invocation.parentInvocationId }
      : {}),
    state: invocation.state,
    ...(invocation.terminationReason !== undefined
      ? { terminationReason: invocation.terminationReason }
      : {}),
    durationMs: duration(invocation.startedAt, invocation.completedAt),
    permissions: {
      readOnly: invocation.readOnly === true,
      workspaceWrite: invocation.role === "worker" && invocation.readOnly !== true,
    },
    ...(invocation.workspaceChange !== undefined
      ? { workspaceChanged: invocation.workspaceChange.changed }
      : {}),
    usageKnown: invocation.outcome?.usage !== undefined,
    ...(invocation.outcome?.usage !== undefined ? { usage: invocation.outcome.usage } : {}),
  };
}

function aggregateUsage(invocations: readonly Invocation[]): RunMetrics["usage"] {
  let any = false;
  const totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const invocation of invocations) {
    const usage = invocation.outcome?.usage;
    if (usage === undefined) {
      continue;
    }
    any = true;
    totals.costUsd += usage.costUsd ?? 0;
    totals.inputTokens += usage.tokens?.inputTokens ?? 0;
    totals.outputTokens += usage.tokens?.outputTokens ?? 0;
    totals.cacheReadInputTokens += usage.tokens?.cacheReadInputTokens ?? 0;
    totals.cacheCreationInputTokens += usage.tokens?.cacheCreationInputTokens ?? 0;
  }
  return {
    costUsd: any ? totals.costUsd : null,
    inputTokens: any ? totals.inputTokens : null,
    outputTokens: any ? totals.outputTokens : null,
    cacheReadInputTokens: any ? totals.cacheReadInputTokens : null,
    cacheCreationInputTokens: any ? totals.cacheCreationInputTokens : null,
  };
}

function countTargetSwitches(invocations: readonly Invocation[]): number {
  const workers = invocations.filter((invocation) => invocation.role === "worker");
  let switches = 0;
  for (let index = 1; index < workers.length; index++) {
    const current = workers[index]?.target;
    const previous = workers[index - 1]?.target;
    if (current?.runtime !== previous?.runtime || current?.model !== previous?.model) {
      switches++;
    }
  }
  return switches;
}

function countEffortEscalations(invocations: readonly Invocation[]): number {
  const workers = invocations.filter((invocation) => invocation.role === "worker");
  let escalations = 0;
  for (let index = 1; index < workers.length; index++) {
    if (
      EFFORT_ORDER[workers[index]?.reasoningEffort ?? "medium"] >
      EFFORT_ORDER[workers[index - 1]?.reasoningEffort ?? "medium"]
    ) {
      escalations++;
    }
  }
  return escalations;
}

function reportWarnings(
  run: Run,
  invocations: readonly InvocationReport[],
  verification: readonly VerificationRecord[],
): string[] {
  const warnings: string[] = [];
  if (run.state === "completed" && run.verificationResult?.passed !== true) {
    warnings.push("run completed without a passing deterministic verification");
  }
  for (const invocation of invocations) {
    if (invocation.role === "worker" && invocation.workspaceChanged === false) {
      warnings.push(`worker invocation ${invocation.id} produced no workspace change`);
    }
  }
  const latest = verification.at(-1)?.failureSignature;
  if (latest !== undefined && latest !== "passed") {
    let repeated = 0;
    for (let index = verification.length - 1; index >= 0; index--) {
      if (verification[index]?.failureSignature !== latest) {
        break;
      }
      repeated++;
    }
    if (repeated > 1) {
      warnings.push(`verification failure repeated consecutively ${repeated} times: ${latest}`);
    }
  }
  return warnings;
}

function acceptanceCoverage(run: Run): RunReport["acceptanceCoverage"] {
  if (run.verificationResult?.passed === true) {
    return { status: "demonstrated", reason: "latest deterministic verification passed" };
  }
  if (run.verificationResult?.passed === false) {
    return { status: "failed", reason: "latest deterministic verification failed" };
  }
  return { status: "not_demonstrated", reason: "no deterministic verification result recorded" };
}

function recordDuration(record: VerificationRecord): number | null {
  return duration(record.startedAt, record.completedAt);
}

function duration(start: string | undefined, end: string | undefined): number | null {
  if (start === undefined || end === undefined) {
    return null;
  }
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function formatMs(ms: number | null): string {
  if (ms === null) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNullable(value: number | null): string {
  return value === null ? "unknown" : String(Number(value.toFixed(6)));
}

function coverageSymbol(status: RunReport["acceptanceCoverage"]["status"]): string {
  if (status === "demonstrated") {
    return "✓";
  }
  if (status === "failed") {
    return "✗";
  }
  return "⚠";
}
