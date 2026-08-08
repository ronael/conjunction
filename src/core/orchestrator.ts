import { randomUUID } from "node:crypto";

import { EventStore, type ConjunctionEvent } from "./events.js";
import { transitionRun, type Run, type VerificationOutcome } from "./run.js";
import { createTask, type Task, type TaskInput } from "./task.js";

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

type EventInput<E = ConjunctionEvent> = E extends ConjunctionEvent
  ? Omit<E, "id" | "timestamp">
  : never;

/**
 * Drives the task/run lifecycle: creates tasks and runs, advances the run
 * state machine, and appends every state change to the event store.
 *
 * Deliberately NOT here: agent runtime invocation (lot 4 plugs an
 * AgentAdapter between startRun and verifyRun), persistence, scheduling,
 * or any multi-agent coordination.
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
   * running|verifying -> failed. Used for agent-level failures (lot 4) and
   * unexpected errors; verification failures go through verifyRun instead.
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

  /** pending|running -> cancelled. */
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
   * running -> verifying -> completed|failed, driven by the injected
   * VerificationRunner. The run's verificationResult is attached either way.
   */
  async verifyRun(runId: string): Promise<Run> {
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
      const failedCommands = outcome.results
        .filter((result) => result.exitCode !== 0 || result.timedOut)
        .map((result) => result.name);
      this.#emit({
        type: "verification.failed",
        taskId: run.taskId,
        runId: run.id,
        payload: { failedCommands },
      });
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
