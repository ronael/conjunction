import type { ReviewFinding } from "./review.js";

/**
 * Run lifecycle states.
 *
 * Allowed transitions (enforced by the state machine below):
 *
 *   pending    -> running | cancelled
 *   running    -> verifying | failed | cancelled
 *   verifying  -> completed | failed | correcting | reviewing | cancelled
 *   correcting -> verifying | failed | cancelled
 *   reviewing  -> completed | cancelled
 *   completed / failed / cancelled are terminal.
 *
 * `correcting` is the bounded feedback loop (lot 6): a failed verification may
 * trigger exactly one correction attempt, after which the run re-enters
 * `verifying`. The orchestrator enforces the cap; from `correcting` the only
 * way back is `verifying` (re-check) or a terminal state — no cycle can loop.
 *
 * `reviewing` (lot 7) is entered only from a PASSED verification when review
 * is enabled, and always terminates in `completed` (reviewer failures are
 * advisory, they never fail the run) or `cancelled`.
 *
 * Cancellation is possible from every non-terminal state, including mid-
 * verification (`verifying -> cancelled`, added in the consolidation pass —
 * its omission made user abort during verification uncancellable).
 */
export type RunState =
  | "pending"
  | "running"
  | "verifying"
  | "correcting"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  pending: ["running", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "failed", "correcting", "reviewing", "cancelled"],
  correcting: ["verifying", "failed", "cancelled"],
  reviewing: ["completed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** The single predicate for "this verification command failed" (timeout or non-zero exit). */
export function isFailedVerificationResult(result: {
  exitCode: number | null;
  timedOut: boolean;
}): boolean {
  return result.timedOut || result.exitCode !== 0;
}

export class InvalidRunStateTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`invalid run state transition: ${from} -> ${to}`);
    this.name = "InvalidRunStateTransitionError";
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new InvalidRunStateTransitionError(from, to);
  }
}

/**
 * Narrow verification summary owned by core.
 *
 * The verification module (lot 3) produces a richer VerificationResult that is
 * structurally assignable to this interface; core never imports the richer type,
 * which keeps the dependency direction one-way (core defines the port).
 */
export interface VerificationOutcome {
  passed: boolean;
  results: {
    name: string;
    exitCode: number | null;
    timedOut: boolean;
  }[];
}

export interface RunResult {
  summary?: string;
  error?: string;
}

/** Process outcome of one agent attempt (initial or correction). */
export interface AgentAttemptOutcome {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  summary?: string;
}

/** Lot 7: outcome of the independent, read-only reviewer invocation. */
export interface RunReview {
  summary: string;
  findings: ReviewFinding[];
  /** false = reviewer output was not parseable; findings[0] holds the raw text. */
  structured: boolean;
  completedAt: string;
  agentResult: AgentAttemptOutcome;
  /** Set when the reviewer invocation itself failed — advisory, run unaffected. */
  error?: string;
}

/**
 * Post-terminal landing record (see docs/land-spec.md). Annotation only —
 * `run.state` stays "completed"; landing is not a lifecycle state.
 */
export interface LandedRecord {
  landedAt: string;
  targetBranch: string;
  /** Target branch HEAD at landing time (apply does not move it). */
  targetCommit: string;
  /** Saved landing patch; manual rollback is `git apply -R <patchPath>`. */
  patchPath: string;
}
/**
 * One agent attempt within a run. Index 1 is the initial attempt; index 2 is
 * the (single, capped) correction attempt and carries the packet that was
 * sent. Recorded on the run so both attempts persist like the rest of the run.
 */
export interface Attempt {
  index: number;
  startedAt: string;
  completedAt?: string;
  agentResult?: AgentAttemptOutcome;
  /** The exact correction packet sent to the agent (correction attempts only). */
  correctionPacket?: string;
}

/**
 * One orchestrated execution of a task, including bounded correction attempts.
 * All timestamps are ISO-8601 strings so runs serialize without loss.
 */
export interface Run {
  readonly id: string;
  readonly taskId: string;
  /** Free-form runtime identifier (e.g. "codex-cli"). */
  runtime: string;
  workspacePath?: string;
  branch?: string;
  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;
  state: RunState;
  attempts: Attempt[];
  result?: RunResult;
  verificationResult?: VerificationOutcome;
  /** Lot 7: independent reviewer outcome (advisory; only when --review). */
  review?: RunReview;
  /**
   * The branch/commit the user had checked out when the run started —
   * the landing target. Missing in runs recorded before landing support.
   */
  baseBranch?: string;
  baseCommit?: string;
  /** Set by `conjunction land` after a successful landing. */
  landed?: LandedRecord;
}

/**
 * The single write path for run state changes. Throws
 * InvalidRunStateTransitionError on any transition outside ALLOWED_TRANSITIONS.
 */
export function transitionRun(run: Run, to: RunState, at: string): void {
  assertTransition(run.state, to);
  run.state = to;
  if (to === "running") {
    run.startedAt = at;
  }
  if (to === "completed" || to === "failed" || to === "cancelled") {
    run.completedAt = at;
  }
}
