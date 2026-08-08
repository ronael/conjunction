/**
 * Run lifecycle states.
 *
 * Allowed transitions (enforced by the state machine below):
 *
 *   pending   -> running | cancelled
 *   running   -> verifying | failed | cancelled
 *   verifying -> completed | failed
 *   completed / failed / cancelled are terminal.
 */
export type RunState = "pending" | "running" | "verifying" | "completed" | "failed" | "cancelled";

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  pending: ["running", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

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

/**
 * One attempt to execute a task.
 * All timestamps are ISO-8601 strings so runs serialize without loss.
 */
export interface Run {
  readonly id: string;
  readonly taskId: string;
  /** Free-form runtime identifier (e.g. "codex-cli"); no adapter exists yet. */
  runtime: string;
  workspacePath?: string;
  branch?: string;
  readonly createdAt: string;
  startedAt?: string;
  completedAt?: string;
  state: RunState;
  result?: RunResult;
  verificationResult?: VerificationOutcome;
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
