import type { AgentCapabilities } from "./agent.js";
import type { ExecutionTarget, Invocation, ReasoningEffort } from "./invocation.js";
import type { Run, VerificationOutcome } from "./run.js";
import { isFailedVerificationResult } from "./run.js";
import { objectiveSection, type Task } from "./task.js";

export type DriverAction = "delegate" | "verify" | "accept" | "stop";

export interface DriverDecision {
  action: DriverAction;
  reason: string;
  targetId?: string;
  objective?: string;
  reasoningEffort?: ReasoningEffort;
  guidance?: string;
}

export interface DriverDecisionRecord extends DriverDecision {
  readonly id: string;
  readonly invocationId: string;
  readonly createdAt: string;
}

export interface DriverTargetOption {
  readonly id: string;
  readonly target: ExecutionTarget;
  readonly capabilities: AgentCapabilities;
}

export interface DriverLimits {
  readonly maxDriverDecisions: number;
  readonly maxWritableInvocations: number;
}

export interface DriverRunConfig {
  readonly driverTarget: ExecutionTarget;
  readonly workerTargets: readonly DriverTargetOption[];
  readonly criticTarget?: ExecutionTarget;
  readonly limits: DriverLimits;
  acceptedDecisionId?: string;
}

export interface DriverProgressFacts {
  readonly driverDecisionCount: number;
  readonly writableInvocationCount: number;
  readonly repeatedFailureSignatureCount: number;
  readonly lastWorkerTargetId?: string;
  readonly lastWorkerEffort?: ReasoningEffort;
  readonly lastWorkerChangedWorkspace?: boolean;
  readonly worktreeChanged: boolean;
}

export const DEFAULT_DRIVER_LIMITS: DriverLimits = {
  maxDriverDecisions: 8,
  maxWritableInvocations: 4,
};

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "maximum",
];

export const DRIVER_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { type: "string", enum: ["delegate", "verify", "accept", "stop"] },
    reason: { type: "string" },
    targetId: { type: "string" },
    objective: { type: "string" },
    reasoningEffort: { type: "string", enum: [...REASONING_EFFORTS] },
    guidance: { type: "string" },
  },
} as const;

export type DriverDecisionParseResult =
  { ok: true; decision: DriverDecision } | { ok: false; error: string };

const DRIVER_DECISION_KEYS = new Set([
  "action",
  "reason",
  "targetId",
  "objective",
  "reasoningEffort",
  "guidance",
]);

export function parseDriverDecision(raw: string): DriverDecisionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid driver JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "driver decision must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DRIVER_DECISION_KEYS.has(key)) {
      return { ok: false, error: `unknown driver decision field: ${key}` };
    }
  }
  if (!isDriverAction(record.action)) {
    return { ok: false, error: "driver decision action is missing or invalid" };
  }
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    return { ok: false, error: "driver decision reason is required" };
  }

  const decision: DriverDecision = {
    action: record.action,
    reason: record.reason,
  };
  if (record.targetId !== undefined) {
    if (typeof record.targetId !== "string" || record.targetId.trim().length === 0) {
      return { ok: false, error: "driver decision targetId must be a non-empty string" };
    }
    decision.targetId = record.targetId;
  }
  if (record.objective !== undefined) {
    if (typeof record.objective !== "string" || record.objective.trim().length === 0) {
      return { ok: false, error: "driver decision objective must be a non-empty string" };
    }
    decision.objective = record.objective;
  }
  if (record.reasoningEffort !== undefined) {
    if (!isReasoningEffort(record.reasoningEffort)) {
      return { ok: false, error: "driver decision reasoningEffort is invalid" };
    }
    decision.reasoningEffort = record.reasoningEffort;
  }
  if (record.guidance !== undefined) {
    if (typeof record.guidance !== "string") {
      return { ok: false, error: "driver decision guidance must be a string" };
    }
    decision.guidance = record.guidance;
  }
  if (decision.action === "delegate") {
    if (decision.targetId === undefined) {
      return { ok: false, error: "delegate decision requires targetId" };
    }
    if (decision.objective === undefined) {
      return { ok: false, error: "delegate decision requires objective" };
    }
  }
  return { ok: true, decision };
}

export function buildDriverPacket(input: {
  task: Task;
  run: Run;
  allowedWorkerTargets: readonly DriverTargetOption[];
  diff: string;
  verificationFresh: boolean;
  limits: DriverLimits;
  progress: DriverProgressFacts;
}): string {
  const facts = {
    brief: {
      title: input.task.title,
      source: input.task.source,
    },
    allowedWorkerTargets: input.allowedWorkerTargets.map((entry) => ({
      id: entry.id,
      target: entry.target,
      capabilities: entry.capabilities,
    })),
    invocations: (input.run.invocations ?? []).map(summarizeInvocation),
    decisions: input.run.driverDecisions ?? [],
    verification: {
      fresh: input.verificationFresh,
      latest: input.run.verificationResult ?? null,
      history: input.run.verificationHistory ?? [],
    },
    progress: input.progress,
    limits: {
      maxDriverDecisions: input.limits.maxDriverDecisions,
      maxWritableInvocations: input.limits.maxWritableInvocations,
      remainingDriverDecisions:
        input.limits.maxDriverDecisions - input.progress.driverDecisionCount,
      remainingWritableInvocations:
        input.limits.maxWritableInvocations - input.progress.writableInvocationCount,
    },
    worktree: {
      changed: input.progress.worktreeChanged,
      diff: boundText(input.diff, 80_000),
    },
  };

  return [
    "You are the Conjunction Driver. You coordinate work in a read-only mode.",
    "Do not modify files. Decide the next single action from the structured facts.",
    "",
    ...objectiveSection(input.task, "## Original brief"),
    "",
    "## Structured facts",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "",
    "## Decision rules",
    "- Return exactly one JSON object matching the provided schema.",
    "- Use action `delegate` to ask one writable worker invocation to do bounded work.",
    "- Use action `verify` to run deterministic checks.",
    "- Use action `accept` only when verification is fresh and green.",
    "- Use action `stop` when the run should fail with your reason.",
    "- Choose targetId only from allowedWorkerTargets.",
    "- Set reasoningEffort only to a value listed in that target's capabilities.reasoningEffort.",
    "- If capabilities.reasoningEffort is empty, omit reasoningEffort for that target.",
  ].join("\n");
}

export function buildDelegatedWorkerPacket(input: {
  task: Task;
  objective: string;
  guidance?: string;
  diff: string;
  latestVerification?: VerificationOutcome;
  reason: string;
}): string {
  const lines = [
    "You are executing a bounded worker invocation inside an isolated git",
    "worktree managed by Conjunction. Complete only the current objective.",
    "",
    ...objectiveSection(input.task, "## Original brief"),
    "",
    "## Current objective",
    input.objective,
    "",
    "## Driver reason",
    input.reason,
  ];
  if (input.guidance !== undefined && input.guidance.trim().length > 0) {
    lines.push("", "## Driver guidance", input.guidance);
  }
  lines.push(
    "",
    "## Latest verification",
    input.latestVerification === undefined
      ? "- No verification has run yet."
      : JSON.stringify(input.latestVerification, null, 2),
    "",
    "## Current worktree diff (bounded evidence)",
    "```diff",
    boundText(input.diff.trimEnd() || "(empty diff)", 80_000),
    "```",
    "",
    "## Workspace rules",
    "- Your working directory is an isolated git worktree on a dedicated branch;",
    "  work only inside this directory.",
    "- Do not run any git commands: no commits, no branch operations, no history",
    "  changes. Leave your changes uncommitted in the working tree.",
    "- Do not read or write files outside this working directory.",
  );
  return lines.join("\n");
}

export function verificationFailureSignature(outcome: VerificationOutcome | undefined): string {
  if (outcome === undefined) {
    return "missing";
  }
  if (outcome.passed) {
    return "passed";
  }
  const failed = outcome.results.filter(isFailedVerificationResult);
  if (failed.length === 0) {
    return "failed-without-command";
  }
  return failed
    .map((result) => `${result.name}:${result.timedOut ? "timeout" : result.exitCode}`)
    .join("|");
}

function summarizeInvocation(invocation: Invocation): {
  id: string;
  parentInvocationId?: string;
  role: Invocation["role"];
  target: ExecutionTarget;
  reasoningEffort: ReasoningEffort;
  readOnly: boolean;
  workspaceChanged?: boolean;
  state: Invocation["state"];
  terminationReason?: Invocation["terminationReason"];
  summary?: string;
} {
  return {
    id: invocation.id,
    ...(invocation.parentInvocationId !== undefined
      ? { parentInvocationId: invocation.parentInvocationId }
      : {}),
    role: invocation.role,
    target: invocation.target,
    reasoningEffort: invocation.reasoningEffort,
    readOnly: invocation.readOnly === true,
    ...(invocation.workspaceChange !== undefined
      ? { workspaceChanged: invocation.workspaceChange.changed }
      : {}),
    state: invocation.state,
    ...(invocation.terminationReason !== undefined
      ? { terminationReason: invocation.terminationReason }
      : {}),
    ...(invocation.outcome?.summary !== undefined
      ? { summary: boundText(invocation.outcome.summary, 2_000) }
      : {}),
  };
}

function isDriverAction(value: unknown): value is DriverAction {
  return value === "delegate" || value === "verify" || value === "accept" || value === "stop";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...(truncated)...`;
}
