import { randomUUID } from "node:crypto";

import type { AgentRunInput, AgentRunResult, RuntimeRegistry } from "./agent.js";
import { EventStore, type ConjunctionEvent } from "./events.js";
import { buildWorkerInstructions } from "./instructions.js";
import type { ExecutionTarget, Invocation, ReasoningEffort } from "./invocation.js";
import { parseReviewReport, countFindingsBySeverity, REVIEW_OUTPUT_SCHEMA } from "./review.js";
import {
  isFailedVerificationResult,
  transitionRun,
  type AgentAttemptOutcome,
  type Attempt,
  type Run,
  type VerificationOutcome,
} from "./run.js";
import { createTask, type Task, type TaskInput } from "./task.js";
import type { WorkflowName } from "./workflow.js";

/** Lot 6: hard cap on self-healing. One correction attempt per run, ever. */
export const MAX_CORRECTIONS_PER_RUN = 1;

/** Names of verification commands that failed in the run's latest outcome. */
function failedCommandNames(run: Run): string[] {
  return (run.verificationResult?.results ?? [])
    .filter(isFailedVerificationResult)
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
  runtimeRegistry?: RuntimeRegistry;
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

export class RuntimeNotFoundError extends Error {
  constructor(readonly runtime: string) {
    super(`unknown agent runtime: ${runtime}`);
    this.name = "RuntimeNotFoundError";
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
  target?: ExecutionTarget;
  reasoningEffort?: ReasoningEffort;
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
 * coordination. Agent runtimes are resolved through a tiny RuntimeRegistry
 * port; core never imports a concrete runtime.
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

  /** `workflow` records which participants this run selects; see workflow.ts. */
  createRun(taskId: string, target: string | ExecutionTarget, workflow?: WorkflowName): Run {
    const task = this.#requireTask(taskId);
    const executionTarget = typeof target === "string" ? { runtime: target } : target;
    const run: Run = {
      id: this.#createId(),
      taskId: task.id,
      runtime: executionTarget.runtime,
      target: executionTarget,
      createdAt: this.#timestamp(),
      state: "pending",
      invocations: [],
      attempts: [],
    };
    if (workflow !== undefined) {
      run.workflow = workflow;
    }
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
    const parentInvocationId = run.attempts[0]?.invocationId;
    const correctionInput: {
      instructions: string;
      parentInvocationId?: string;
      target?: ExecutionTarget;
    } = {
      instructions: packet,
    };
    if (parentInvocationId !== undefined) {
      correctionInput.parentInvocationId = parentInvocationId;
    }
    const parentTarget = this.#invocationById(run, parentInvocationId)?.target;
    if (parentTarget !== undefined) {
      correctionInput.target = parentTarget;
    }
    const result = await this.#executeAgentAttempt(run, task, options, correctionInput);
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
    inputOptions?: {
      instructions?: string;
      parentInvocationId?: string;
      role?: "worker" | "critic";
      target?: ExecutionTarget;
      reasoningEffort?: ReasoningEffort;
      readOnly?: boolean;
      outputSchema?: unknown;
    },
  ): Promise<AgentRunResult> {
    if (!this.deps.runtimeRegistry) {
      throw new MissingDependencyError("runtimeRegistry");
    }
    if (run.workspacePath === undefined) {
      throw new RunNotExecutableError(
        "run has no workspace (startRun without a workspace provider)",
      );
    }

    const invocationOptions: {
      parentInvocationId?: string;
      target?: ExecutionTarget;
      reasoningEffort?: ReasoningEffort;
      readOnly?: boolean;
    } = {};
    if (inputOptions?.parentInvocationId !== undefined) {
      invocationOptions.parentInvocationId = inputOptions.parentInvocationId;
    }
    if (inputOptions?.readOnly !== undefined) {
      invocationOptions.readOnly = inputOptions.readOnly;
    }
    if (inputOptions?.target !== undefined) {
      invocationOptions.target = inputOptions.target;
    } else if (options.target !== undefined) {
      invocationOptions.target = options.target;
    }
    if (inputOptions?.reasoningEffort !== undefined) {
      invocationOptions.reasoningEffort = inputOptions.reasoningEffort;
    } else if (options.reasoningEffort !== undefined) {
      invocationOptions.reasoningEffort = options.reasoningEffort;
    }
    const invocation = this.#createInvocation(
      run,
      inputOptions?.role ?? "worker",
      invocationOptions,
    );
    const adapter = this.deps.runtimeRegistry.get(invocation.target.runtime);
    if (!adapter) {
      throw new RuntimeNotFoundError(invocation.target.runtime);
    }
    invocation.state = "running";
    invocation.startedAt = this.#timestamp();

    const attempt: Attempt = {
      index: run.attempts.length + 1,
      invocationId: invocation.id,
      startedAt: invocation.startedAt,
    };
    if (inputOptions?.instructions !== undefined) {
      attempt.correctionPacket = inputOptions.instructions;
    }
    run.attempts.push(attempt);

    this.#emit({
      type: "agent.started",
      taskId: run.taskId,
      runId: run.id,
      payload: { runtime: invocation.target.runtime, invocationId: invocation.id },
    });

    const input: AgentRunInput = {
      target: invocation.target,
      reasoningEffort: invocation.reasoningEffort,
      instructions: inputOptions?.instructions ?? buildWorkerInstructions(task),
      workspacePath: run.workspacePath,
      timeoutMs: options.timeoutMs,
      onOutput: (chunk, stream) => {
        this.#emit({
          type: "agent.output",
          taskId: run.taskId,
          runId: run.id,
          payload: { invocationId: invocation.id, stream, chunk },
        });
        options.onOutput?.(chunk, stream);
      },
    };
    if (options.signal !== undefined) {
      input.signal = options.signal;
    }
    if (inputOptions?.readOnly !== undefined) {
      input.readOnly = inputOptions.readOnly;
    }
    if (inputOptions?.outputSchema !== undefined) {
      input.outputSchema = inputOptions.outputSchema;
    }

    const result = await adapter.run(input);

    attempt.completedAt = this.#timestamp();
    attempt.agentResult = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
    if (result.lastMessage !== undefined) {
      attempt.agentResult.summary = result.lastMessage;
    }
    invocation.completedAt = attempt.completedAt;
    invocation.outcome = attempt.agentResult;

    this.#emit({
      type: "agent.completed",
      taskId: run.taskId,
      runId: run.id,
      payload: { exitCode: result.exitCode, invocationId: invocation.id },
    });
    if (result.lastMessage !== undefined) {
      run.result = { summary: result.lastMessage };
    }

    if (result.aborted) {
      invocation.state = "cancelled";
      invocation.terminationReason = "aborted";
      this.cancelRun(run.id, "agent execution aborted");
    } else if (result.timedOut) {
      invocation.state = "failed";
      invocation.terminationReason = "timed_out";
      this.failRun(run.id, `agent timed out after ${options.timeoutMs}ms`);
    } else if (result.exitCode !== 0) {
      invocation.state = "failed";
      invocation.terminationReason = "process_failed";
      this.failRun(run.id, `agent exited with code ${result.exitCode ?? "null (killed)"}`);
    } else {
      invocation.state = "completed";
      invocation.terminationReason = "completed";
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

  /** Cancellation is possible from every non-terminal state. */
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
   *
   * Lot 7: with `{ review: true }`, a PASSED verification transitions to
   * "reviewing" instead of "completed"; call reviewRun next.
   */
  async verifyRun(
    runId: string,
    options?: { correction?: boolean; review?: boolean },
  ): Promise<Run> {
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
      if (options?.review === true) {
        transitionRun(run, "reviewing", this.#timestamp());
        return run;
      }
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

  /**
   * Lot 7: the independent reviewer — a second, READ-ONLY invocation of the
   * same adapter against the same worktree, after the final verification
   * passed (run must be in state "reviewing", i.e. verifyRun with
   * `{ review: true }`).
   *
   * The reviewer is advisory: a reviewer crash/timeout NEVER fails the run —
   * it is recorded on `run.review.error` and the run completes. Findings
   * never feed the correction loop. Abort (q / Ctrl-C) cancels the run.
   */
  async reviewRun(runId: string, packet: string, options: ExecuteRunOptions): Promise<Run> {
    const run = this.#requireRun(runId);
    const task = this.#requireTask(run.taskId);
    if (!this.deps.runtimeRegistry) {
      throw new MissingDependencyError("runtimeRegistry");
    }
    if (run.state !== "reviewing") {
      throw new RunNotExecutableError(`state must be "reviewing", got "${run.state}"`);
    }
    if (run.workspacePath === undefined) {
      throw new RunNotExecutableError(
        "run has no workspace (startRun without a workspace provider)",
      );
    }

    this.#emit({ type: "review.started", taskId: run.taskId, runId: run.id, payload: {} });
    const parentInvocationId = run.attempts.at(-1)?.invocationId;
    const invocation = this.#createInvocation(run, "critic", {
      ...(parentInvocationId !== undefined ? { parentInvocationId } : {}),
      ...(options.target !== undefined ? { target: options.target } : {}),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
      readOnly: true,
    });
    const adapter = this.deps.runtimeRegistry.get(invocation.target.runtime);
    if (!adapter) {
      throw new RuntimeNotFoundError(invocation.target.runtime);
    }
    invocation.state = "running";
    invocation.startedAt = this.#timestamp();

    this.#emit({
      type: "agent.started",
      taskId: run.taskId,
      runId: run.id,
      payload: { runtime: invocation.target.runtime, invocationId: invocation.id },
    });

    const input: AgentRunInput = {
      target: invocation.target,
      reasoningEffort: invocation.reasoningEffort,
      instructions: packet,
      workspacePath: run.workspacePath,
      timeoutMs: options.timeoutMs,
      readOnly: true, // hard rule: the reviewer NEVER gets write access
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      onOutput: (chunk, stream) => {
        this.#emit({
          type: "agent.output",
          taskId: run.taskId,
          runId: run.id,
          payload: { invocationId: invocation.id, stream, chunk },
        });
        options.onOutput?.(chunk, stream);
      },
    };
    if (options.signal !== undefined) {
      input.signal = options.signal;
    }

    const result = await adapter.run(input);
    const agentResult: AgentAttemptOutcome = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
    if (result.lastMessage !== undefined) {
      agentResult.summary = result.lastMessage;
    }
    invocation.completedAt = this.#timestamp();
    invocation.outcome = agentResult;
    this.#emit({
      type: "agent.completed",
      taskId: run.taskId,
      runId: run.id,
      payload: { exitCode: result.exitCode, invocationId: invocation.id },
    });

    if (result.aborted) {
      invocation.state = "cancelled";
      invocation.terminationReason = "aborted";
      this.cancelRun(run.id, "review aborted");
      return run;
    }

    const counts = { total: 0, critical: 0, major: 0, minor: 0, nit: 0, errored: false };
    if (result.timedOut || result.exitCode !== 0) {
      const error = result.timedOut
        ? `reviewer timed out after ${options.timeoutMs}ms`
        : `reviewer exited with code ${result.exitCode ?? "null (killed)"}`;
      run.review = {
        summary: "",
        findings: [],
        structured: false,
        completedAt: this.#timestamp(),
        agentResult,
        error,
      };
      counts.errored = true;
      invocation.state = "failed";
      invocation.terminationReason = result.timedOut ? "timed_out" : "process_failed";
    } else {
      const parsed = parseReviewReport(result.lastMessage ?? "");
      run.review = {
        summary: parsed.report.summary,
        findings: parsed.report.findings,
        structured: parsed.structured,
        completedAt: this.#timestamp(),
        agentResult,
      };
      counts.total = parsed.report.findings.length;
      Object.assign(counts, countFindingsBySeverity(parsed.report.findings));
      invocation.state = "completed";
      invocation.terminationReason = "completed";
    }
    this.#emit({
      type: "review.completed",
      taskId: run.taskId,
      runId: run.id,
      payload: counts,
    });

    transitionRun(run, "completed", this.#timestamp());
    task.status = "completed";
    this.#emit({ type: "run.completed", taskId: run.taskId, runId: run.id, payload: {} });
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

  #createInvocation(
    run: Run,
    role: Invocation["role"],
    options: {
      parentInvocationId?: string;
      target?: ExecutionTarget;
      reasoningEffort?: ReasoningEffort;
      readOnly?: boolean;
    } = {},
  ): Invocation {
    const invocation: Invocation = {
      id: this.#createId(),
      runId: run.id,
      ...(options.parentInvocationId !== undefined
        ? { parentInvocationId: options.parentInvocationId }
        : {}),
      role,
      target: options.target ?? run.target ?? { runtime: run.runtime },
      reasoningEffort: options.reasoningEffort ?? "medium",
      createdAt: this.#timestamp(),
      state: "pending",
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    };
    run.invocations ??= [];
    run.invocations.push(invocation);
    return invocation;
  }

  #emit(input: EventInput): void {
    const event = {
      ...input,
      id: this.#createId(),
      timestamp: this.#timestamp(),
    } as ConjunctionEvent;
    this.events.append(event);
  }

  #invocationById(run: Run, invocationId: string | undefined): Invocation | undefined {
    if (invocationId === undefined) {
      return undefined;
    }
    return run.invocations?.find((invocation) => invocation.id === invocationId);
  }
}
