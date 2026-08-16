import type { AgentAttemptOutcome } from "./run.js";
import type { Role } from "./workflow.js";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "maximum";

/**
 * Opaque execution target chosen by Conjunction. Core records the intent; a
 * concrete adapter decides which runtime-specific flags it can truthfully emit.
 */
export interface ExecutionTarget {
  readonly runtime: string;
  readonly model?: string;
}

export type InvocationState = "pending" | "running" | "completed" | "failed" | "cancelled";

export type InvocationTerminationReason = "completed" | "process_failed" | "timed_out" | "aborted";

export interface InvocationWorkspaceChange {
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly changed: boolean;
}

/**
 * One agent invocation within a run: worker attempt, correction attempt,
 * future driver call, or critic call. It is deliberately a record, not a
 * scheduler or session framework.
 */
export interface Invocation {
  readonly id: string;
  readonly runId: string;
  readonly parentInvocationId?: string;
  readonly role: Role;
  readonly target: ExecutionTarget;
  readonly reasoningEffort: ReasoningEffort;
  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;
  state: InvocationState;
  outcome?: AgentAttemptOutcome;
  terminationReason?: InvocationTerminationReason;
  /** Read-only is an execution constraint for critic/reviewer invocations. */
  readOnly?: boolean;
  /** Deterministic workspace-diff comparison captured around writable invocations. */
  workspaceChange?: InvocationWorkspaceChange;
}
