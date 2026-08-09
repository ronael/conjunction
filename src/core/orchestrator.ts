import { randomUUID } from "node:crypto";

import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./agent.js";
import { EventStore, type ConjunctionEvent } from "./events.js";
import { transitionRun, type Attempt, type Run, type VerificationOutcome } from "./run.js";
import { createTask, type Task, type TaskInput } from "./task.js";

/** Lot 6: hard cap on self-healing. One correction attempt per run, ever. */
export const MAX_CORRECTIONS_PER_RUN = 1;

/** Names of verification commands that failed in the run's latest outcome. */
function failedCommandNames(run: Run): string[] {
  return (run.verificationResult?.results ?? [])
    .filter((result) => result.exitCode !== 0 || result.timedOut)
    .map((result) => result.name);
}

/** Narrow port through which core asks for an isolated workspace (implemented in lot 2). */
export interface WorkspaceHandle {
  workspacePath: string;
  branch: string;
}

export interface WorkspaceProvider {
  createWorkspace(run: Run): Promise<WorkspaceHandle>;
}

/** Narrow port through which core asks for deterministic verification (implemented in lot 3). */
export interface VerificationRunner {
  verify(run: Run): Promise<VerificationOutcome>;
}

export interface OrchestratorDeps {
  workspace?: WorkspaceProvider;
  verification?: VerificationRunner;
  agent?: AgentAdapter;
  createId?: () => string;
  now?: () => Date;
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`unknown task: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`unknown run: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class MissingDependencyError extends Error {
  constructor(dependency: string) {
    super(`orchestrator dependency not configured: ${dependency}`);
    this.name = "MissingDependencyError";
  }
}

/** The run is not in a state/shape that allows executing an agent on it. */
export class RunNotExecutableError extends Error {
  constructor(reason: string) {
    super(`run is not executable: ${reason}`);
    this.name = "RunNotExecutableError";
  }
}

export interface ExecuteRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Forwarded agent output, after it has been recorded as agent.output events. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

type EventInput<E = ConjunctionEvent> = E extends ConjunctionEvent
  ? Omit<E, "id" | "timestamp">
  : never;

/**
 * Drives the task/run lifecycle: creates tasks and runs, advances the run
 * state machine, and appends every state change to the event store.
 *
 * Deliberately NOT here: persistence, scheduling, or any multi-agent
 * coordination. The agent itself is injected as an AgentAdapter port; core
 * never imports a concrete runtime.
 */
export class Orchestrator {
  readonly events = new EventStore();

  #tasks = new Map<string, Task>();
  #runs = new Map<string, Run>();
  #createId: () => string;
  #now: () => Date;

  constructor(private readonly deps: OrchestratorDeps = {}) {
    this.#createId = deps.createId ?? randomUUID;
    this.#now = deps.now ?? (() => new Date());
  }

  createTask(input: TaskInput): Task {
    const task = createTask(input, { createId: this.#createId });
    this.#tasks.set(task.id, task);
    this.#emit({ type: "task.created", taskId: task.id, payload: { title: task.title } });
    return task;
  }

  getTask(taskId: string): Task {
    return this.#requireTask(taskId);
  }

  getRun(runId: string): Run {
    return this.#requireRun(runId);
  }

  createRun(taskId: string, runtime: string): Run {
    const task = this.#requireTask(taskId);
    const run: Run = {
      id: this.#createId(),
      taskId: task.id,
      runtime,
      createdAt: this.#timestamp(),
      state: "pending",
      attempts: [],
    };
    this.#runs.set(run.id, run);
    return run;
  }

  /**
   * pending -> running. Creates the isolated workspace first when a workspace
   * provider is configured.
   */
  async startRun(runId: string): Promise<Run> {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    transitionRun(run, "running", this.#timestamp());
    task.status = "in_progress";
    this.#emit({
      type: "run.started",
      taskId: run.taskId,
      runId: run.id,
      payload: { runtime: run.runtime },
    });

    if (this.deps.workspace) {
      const handle = await this.deps.workspace.createWorkspace(run);
      run.workspacePath = handle.workspacePath;
      run.branch = handle.branch;
      this.#emit({
        type: "workspace.created",
        taskId: run.taskId,
        runId: run.id,
        payload: { workspacePath: handle.workspacePath, branch: handle.branch },
      });
    }
    return run;
  }

  /**
   * Executes the injected AgentAdapter for a running run (the initial attempt).
   * The run must be in state "running" (call startRun first) and must have a
   * workspace — agents only ever execute inside an isolated worktree.
   *
   * Outcome mapping: success keeps the run "running" (verification decides
   * pass/fail); timeout or non-zero exit fails the run; abort cancels it.
   */
  async executeRun(runId: string, options: ExecuteRunOptions): Promise<Run> {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    if (run.state !== "running") {
      throw new RunNotExecutableError(`state must be "running", got "${run.state}"`);
    }
    if (run.attempts.length > 0) {
      throw new RunNotExecutableError("initial attempt already executed");
    }
    await this.#executeAgentAttempt(run, task, options);
    return run;
  }

  /**
   * The single bounded correction attempt (lot 6). The run must be in state
   * "correcting" (verifyRun with correction enabled put it there after a
   * failed verification). The packet — built by buildCorrectionPacket in the
   * composition layer — is stored on the attempt and sent to the same worker.
   * Success leaves the run in "correcting"; call verifyRun again to re-check.
   */
  async executeCorrection(runId: string, packet: string, options: ExecuteRunOptions): Promise<Run> {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    if (run.state !== "correcting") {
      throw new RunNotExecutableError(`state must be "correcting", got "${run.state}"`);
    }
    const failedCommands = failedCommandNames(run);
    const result = await this.#executeAgentAttempt(run, task, options, packet);
    if (!result.aborted && !result.timedOut && result.exitCode === 0) {
      this.#emit({
        type: "correction.completed",
        taskId: run.taskId,
        runId: run.id,
        payload: { attemptIndex: run.attempts.length, failedCommands },
      });
    }
    return run;
  }

  /**
   * Shared agent invocation for initial and correction attempts. Records the
   * attempt on the run, emits agent.* events, and maps the process outcome
   * onto run state (abort -> cancelled, timeout/non-zero exit -> failed).
   */
  async #executeAgentAttempt(
    run: Run,
    task: Task,
    options: ExecuteRunOptions,
    correctionPacket?: string,
  ): Promise<AgentRunResult> {
    if (!this.deps.agent) {
      throw new MissingDependencyError("agent");
    }
    if (run.workspacePath === undefined) {
      throw new RunNotExecutableError(
        "run has no workspace (startRun without a workspace provider)",
      );
    }

    const attempt: Attempt = { index: run.attempts.length + 1, startedAt: this.#timestamp() };
    if (correctionPacket !== undefined) {
      attempt.correctionPacket = correctionPacket;
    }
    run.attempts.push(attempt);

    this.#emit({
      type: "agent.started",
      taskId: run.taskId,
      runId: run.id,
      payload: { runtime: run.runtime },
    });

    const input: AgentRunInput = {
      task,
      workspacePath: run.workspacePath,
      timeoutMs: options.timeoutMs,
      onOutput: (chunk, stream) => {
        this.#emit({
          type: "agent.output",
          taskId: run.taskId,
          runId: run.id,
          payload: { stream, chunk },
        });
        options.onOutput?.(chunk, stream);
      },
    };
    if (options.signal !== undefined) {
      input.signal = options.signal;
    }
    if (correctionPacket !== undefined) {
      input.correctionPacket = correctionPacket;
    }

    const result = await this.deps.agent.run(input);

    attempt.completedAt = this.#timestamp();
    attempt.agentResult = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
    if (result.lastMessage !== undefined) {
      attempt.agentResult.summary = result.lastMessage;
    }

    this.#emit({
      type: "agent.completed",
      taskId: run.taskId,
      runId: run.id,
      payload: { exitCode: result.exitCode },
    });
    if (result.lastMessage !== undefined) {
      run.result = { summary: result.lastMessage };
    }

    if (result.aborted) {
      this.cancelRun(run.id, "agent execution aborted");
    } else if (result.timedOut) {
      this.failRun(run.id, `agent timed out after ${options.timeoutMs}ms`);
    } else if (result.exitCode !== 0) {
      this.failRun(run.id, `agent exited with code ${result.exitCode ?? "null (killed)"}`);
    }
    return result;
  }

  /**
   * running|verifying -> failed. Used for agent-level failures and unexpected
   * errors; verification failures go through verifyRun instead.
   */
  failRun(runId: string, error: string): Run {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    transitionRun(run, "failed", this.#timestamp());
    run.result = { error };
    task.status = "failed";
    this.#emit({
      type: "run.failed",
      taskId: run.taskId,
      runId: run.id,
      payload: { error },
    });
    return run;
  }

  /** pending|running|correcting -> cancelled. */
  cancelRun(runId: string, reason?: string): Run {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    transitionRun(run, "cancelled", this.#timestamp());
    task.status = "cancelled";
    this.#emit({
      type: "run.cancelled",
      taskId: run.taskId,
      runId: run.id,
      payload: reason === undefined ? {} : { reason },
    });
    return run;
  }

  /**
   * running -> verifying -> completed | failed, driven by the injected
   * VerificationRunner. The run's verificationResult is attached either way.
   *
   * Lot 6: with `{ correction: true }`, a failed verification transitions to
   * "correcting" instead of "failed" — exactly once per run. After the
   * correction attempt, call verifyRun again (the cap then forces terminal).
   */
  async verifyRun(runId: string, options?: { correction?: boolean }): Promise<Run> {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    if (!this.deps.verification) {
      throw new MissingDependencyError("verification");
    }
    transitionRun(run, "verifying", this.#timestamp());
    this.#emit({
      type: "verification.started",
      taskId: run.taskId,
      runId: run.id,
      payload: {},
    });

    const outcome = await this.deps.verification.verify(run);
    run.verificationResult = outcome;

    if (outcome.passed) {
      this.#emit({
        type: "verification.passed",
        taskId: run.taskId,
        runId: run.id,
        payload: {},
      });
      transitionRun(run, "completed", this.#timestamp());
      task.status = "completed";
      this.#emit({
        type: "run.completed",
        taskId: run.taskId,
        runId: run.id,
        payload: {},
      });
    } else {
      const failedCommands = failedCommandNames(run);
      this.#emit({
        type: "verification.failed",
        taskId: run.taskId,
        runId: run.id,
        payload: { failedCommands },
      });
      const correctionsUsed = run.attempts.filter(
        (attempt) => attempt.correctionPacket !== undefined,
      ).length;
      if (options?.correction === true && correctionsUsed < MAX_CORRECTIONS_PER_RUN) {
        transitionRun(run, "correcting", this.#timestamp());
        this.#emit({
          type: "correction.started",
          taskId: run.taskId,
          runId: run.id,
          payload: { attemptIndex: run.attempts.length + 1, failedCommands },
        });
      } else {
        transitionRun(run, "failed", this.#timestamp());
        const error = `verification failed: ${failedCommands.join(", ")}`;
        run.result = { error };
        task.status = "failed";
        this.#emit({
          type: "run.failed",
          taskId: run.taskId,
          runId: run.id,
          payload: { error },
        });
      }
    }
    return run;
  }

  #requireTask(taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  #requireRun(runId: string): Run {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    return run;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #emit(input: EventInput): void {
    const event = {
      ...input,
      id: this.#createId(),
      timestamp: this.#timestamp(),
    } as ConjunctionEvent;
    this.events.append(event);
  }
}
