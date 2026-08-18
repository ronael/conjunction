import path from "node:path";

import type {
  ExecutionTarget,
  DriverDecisionRecord,
  DriverLimits,
  Orchestrator,
  ReasoningEffort,
  Run,
  RunReview,
  RunState,
  RuntimeRegistry,
  Task,
  WorkflowName,
} from "../core/index.js";
import {
  buildCorrectionPacket,
  buildReviewerPacket,
  isFailedVerificationResult,
  workflowIncludes,
} from "../core/index.js";
import type {
  CommandResult,
  VerificationCommand,
  VerificationResult,
} from "../verification/index.js";
import { getCurrentBranch, getHeadCommit, getWorktreeDiff } from "../workspace/index.js";

import type { Brief } from "./brief.js";
import { findingsSummary, formatDuration } from "./format.js";
import { runQualityTask } from "./quality-workflow.js";
import { createRunExecutionSession } from "./run-session.js";

/** Daytona-style checklist line for plain output: "✓ Workspace ready    <detail>". */
function stepLine(symbol: string, label: string, detail?: string): string {
  const left = `${symbol} ${label}`;
  return detail === undefined ? `${left}\n` : `${left.padEnd(28)}${detail}\n`;
}

function attemptDuration(attempt: Run["attempts"][number] | undefined): string | undefined {
  if (attempt?.startedAt === undefined || attempt.completedAt === undefined) {
    return undefined;
  }
  return formatDuration(Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt));
}

/** Checklist line for a finished agent attempt, derived from the run state. */
function agentStepLine(run: Run, label: string): string {
  const attempt = run.attempts.at(-1);
  if (run.state === "failed") {
    return stepLine(
      "✗",
      label,
      attempt?.agentResult?.error?.message ?? run.result?.error ?? "failed",
    );
  }
  if (run.state === "cancelled") {
    return stepLine("■", label, attempt?.agentResult?.error?.message ?? "cancelled");
  }
  return stepLine("✓", label, attemptDuration(attempt));
}

export interface SelectedRuntimeTarget {
  role: "driver" | "worker" | "critic" | "observer";
  target: ExecutionTarget;
  explicitEffort?: ReasoningEffort;
  requiresReadOnly?: boolean;
  requiresStructuredOutput?: boolean;
}

export function selectedRuntimeTargets(
  options: RunTaskOptions,
  workflow: WorkflowName,
): SelectedRuntimeTarget[] {
  const selected: SelectedRuntimeTarget[] = [
    {
      role: "worker",
      target: options.workerTarget,
      ...(options.workerReasoningEffort !== undefined
        ? { explicitEffort: options.workerReasoningEffort }
        : {}),
    },
  ];
  if (workflow === "quality") {
    selected.unshift({
      role: "driver",
      target: options.driverTarget ?? options.workerTarget,
      requiresReadOnly: true,
      requiresStructuredOutput: true,
      ...(options.driverReasoningEffort !== undefined
        ? { explicitEffort: options.driverReasoningEffort }
        : {}),
    });
  }
  if (workflowIncludes(workflow, "critic")) {
    selected.push({
      role: "critic",
      target: options.criticTarget ?? options.workerTarget,
      requiresReadOnly: true,
      requiresStructuredOutput: true,
      ...(options.criticReasoningEffort !== undefined
        ? { explicitEffort: options.criticReasoningEffort }
        : {}),
    });
  }
  if (options.observerTarget !== undefined) {
    selected.push({
      role: "observer",
      target: options.observerTarget,
      requiresReadOnly: true,
      requiresStructuredOutput: true,
      ...(options.observerReasoningEffort !== undefined
        ? { explicitEffort: options.observerReasoningEffort }
        : {}),
    });
  }
  return selected;
}

export interface WorkerTargetInput {
  id: string;
  target: ExecutionTarget;
}

export interface RunTaskOptions {
  /** The run's source of truth: inline description or loaded brief file. */
  brief: Brief;
  /** Which participants take part. Correction is orthogonal (see `correct`). */
  workflow: WorkflowName;
  /** Target used for worker invocations (initial + correction). */
  workerTarget: ExecutionTarget;
  /** Explicit worker effort intent; default is recorded as medium by core. */
  workerReasoningEffort?: ReasoningEffort;
  /** Allowed writable worker targets for the Driver workflow. */
  workerTargets?: readonly WorkerTargetInput[];
  /** Target used for Driver invocations; defaults to workerTarget. */
  driverTarget?: ExecutionTarget;
  /** Explicit driver effort intent; default is recorded as medium by core. */
  driverReasoningEffort?: ReasoningEffort;
  /** Target used for the critic invocation; defaults to the worker target. */
  criticTarget?: ExecutionTarget;
  /** Explicit critic effort intent; default is recorded as medium by core. */
  criticReasoningEffort?: ReasoningEffort;
  /** Optional read-only Observer invocation target, run after the workflow outcome is fixed. */
  observerTarget?: ExecutionTarget;
  /** Explicit observer effort intent; default is recorded as medium by core. */
  observerReasoningEffort?: ReasoningEffort;
  repoPath: string;
  /** Empty list = no verification; the run still completes (vacuous pass). */
  verifyCommands: VerificationCommand[];
  timeoutMinutes: number;
  cleanup: boolean;
  /**
   * Lot 6: on verification failure, send one bounded correction packet to the
   * same worker and re-verify. Meaningful only when verifyCommands is non-empty.
   */
  correct: boolean;
  /** Deterministic caps for the Driver workflow; defaults live in core. */
  qualityLimits?: Partial<DriverLimits>;
}

/**
 * Fine-grained progress hooks for live UIs. All optional; the plain CLI
 * output path does not use them. The TUI implements this to feed its model —
 * the engine itself never knows a UI exists.
 */
export interface RunObserver {
  /** Once, right after the workspace exists. */
  context?(ctx: { run: Run; task: Task; repoRoot: string; storeDir: string }): void;
  agentOutput?(chunk: string, stream: "stdout" | "stderr"): void;
  /** Quality workflow: the read-only Driver invocation is starting. */
  driverStarted?(): void;
  /** Quality workflow: the Driver produced a parsed decision. */
  driverDecision?(decision: DriverDecisionRecord): void;
  /** Quality workflow: the current Worker invocation finished. */
  workerFinished?(outcome: "completed" | "failed" | "cancelled"): void;
  /** Quality workflow: the Driver accepted the implementation. */
  driverAccepted?(): void;
  /** Quality workflow: the final verification before review is starting. */
  finalVerificationStarted?(): void;
  verificationStarted?(): void;
  /** Verification finished (either round); `passed` is the aggregate outcome. */
  verificationFinished?(passed: boolean): void;
  commandStarted?(command: VerificationCommand): void;
  commandFinished?(command: VerificationCommand, result: CommandResult): void;
  /** Verification failed and the single correction attempt is starting. */
  correctionStarted?(failedCommands: string[]): void;
  /** Lot 7: the independent reviewer is starting. */
  reviewStarted?(): void;
  /** Lot 7: reviewer done (possibly with an advisory error). */
  reviewFinished?(review: RunReview): void;
  /** Lot 4: the post-run Observer is starting. */
  observerStarted?(): void;
}

export interface RunTaskDeps {
  runtimeRegistry: RuntimeRegistry;
  out: (chunk: string) => void;
  observer?: RunObserver;
  /** Cancellation (q / Ctrl-C): forwarded to Orchestrator.executeRun. */
  signal?: AbortSignal;
}

export interface RunTaskResult {
  exitCode: number;
  repoRoot: string;
  storeDir: string;
  /** Absent only when setup failed before a run could be created (exitCode 2). */
  run?: Run;
  task?: Task;
  verification?: VerificationResult;
  /** Human-readable outcome of the cleanup attempt, when requested. */
  cleanupNote?: string;
}

/**
 * The Lot 5 vertical slice:
 * task -> worktree -> agent -> verification -> summary, with run metadata and
 * events persisted under `.conjunction/runs/`. The result's exitCode is 0 when
 * the run completed (agent clean + verification passed/vacuous).
 */
export async function runTask(options: RunTaskOptions, deps: RunTaskDeps): Promise<RunTaskResult> {
  if (options.workflow === "quality") {
    return await runQualityTask(options, deps);
  }

  const { out, observer } = deps;
  const selectedTargets = selectedRuntimeTargets(options, options.workflow);

  for (const selected of selectedTargets) {
    const adapter = deps.runtimeRegistry.get(selected.target.runtime);
    if (!adapter) {
      out(
        `error: unknown agent runtime "${selected.target.runtime}" ` +
          `(available: ${deps.runtimeRegistry.ids().join(", ") || "none"})\n`,
      );
      return { exitCode: 2, repoRoot: "", storeDir: "" };
    }
    if (selected.explicitEffort !== undefined) {
      const supported = adapter.capabilities().reasoningEffort;
      if (!supported.includes(selected.explicitEffort)) {
        out(
          `error: ${selected.role} runtime "${adapter.id}" does not support reasoning effort ` +
            `"${selected.explicitEffort}" (supported: ${supported.join(", ") || "none"})\n`,
        );
        return { exitCode: 2, repoRoot: "", storeDir: "" };
      }
    }
    const capabilities = adapter.capabilities();
    if (selected.requiresReadOnly === true && !capabilities.supportsReadOnly) {
      out(`error: ${selected.role} runtime "${adapter.id}" does not support read-only execution\n`);
      return { exitCode: 2, repoRoot: "", storeDir: "" };
    }
    if (selected.requiresStructuredOutput === true && !capabilities.supportsStructuredOutput) {
      out(`error: ${selected.role} runtime "${adapter.id}" does not support structured output\n`);
      return { exitCode: 2, repoRoot: "", storeDir: "" };
    }
    const availability = await adapter.detect();
    if (!availability.available) {
      out(
        `error: agent runtime "${adapter.id}" is not available: ` +
          `${availability.reason ?? "unknown reason"}\n`,
      );
      return { exitCode: 2, repoRoot: "", storeDir: "" };
    }
  }

  let session: Awaited<ReturnType<typeof createRunExecutionSession>>;
  try {
    session = await createRunExecutionSession(options, deps);
  } catch {
    out(`error: not a git repository: ${options.repoPath}\n`);
    return { exitCode: 2, repoRoot: "", storeDir: "" };
  }
  const { repoRoot, orchestrator, store } = session;
  const flush = session.flush;
  const throwIfAborted = session.throwIfAborted;

  const { brief } = options;
  const task = orchestrator.createTask({
    title: brief.title,
    objective: brief.content,
    source: brief.source,
  });
  const run = orchestrator.createRun(task.id, options.workerTarget, options.workflow);
  out(`run:      ${run.id}\ntask:     ${task.title}\n`);
  if (brief.source.kind === "file") {
    out(`brief:    ${brief.source.path}\n`);
  }
  out(`workflow: ${options.workflow}\n\n`);

  const hasVerify = options.verifyCommands.length > 0;
  const failedVerifyNames = (): string =>
    (run.verificationResult?.results ?? [])
      .filter(isFailedVerificationResult)
      .map((result) => result.name)
      .join(", ");

  try {
    throwIfAborted();
    // record the landing base BEFORE the worktree forks from HEAD
    // (see docs/land-spec.md §2: required for `conjunction land` guards)
    run.baseBranch = await getCurrentBranch(repoRoot);
    run.baseCommit = await getHeadCommit(repoRoot);
    await orchestrator.startRun(run.id);
    await flush(task, run);
    out(stepLine("✓", "Workspace ready", run.branch));
    out(`  worktree: ${run.workspacePath ?? "-"}\n`);
    observer?.context?.({ run, task, repoRoot, storeDir: store.dir });
    out("\n── agent output ──\n");

    const executeOptions: Parameters<Orchestrator["executeRun"]>[1] = {
      timeoutMs: options.timeoutMinutes * 60_000,
      target: options.workerTarget,
      ...(options.workerReasoningEffort !== undefined
        ? { explicitReasoningEffort: options.workerReasoningEffort }
        : {}),
      onOutput: (chunk, stream) => {
        observer?.agentOutput?.(chunk, stream);
        out(chunk);
      },
    };
    if (deps.signal !== undefined) {
      executeOptions.signal = deps.signal;
    }
    await orchestrator.executeRun(run.id, executeOptions);
    await flush(task, run);
    out(agentStepLine(run, "Agent (attempt 1)"));

    if (run.state === "running") {
      if (hasVerify) {
        out("\n── verification ──\n");
      }
      throwIfAborted();
      observer?.verificationStarted?.();
      // agent finished cleanly; an empty verify list passes trivially
      await orchestrator.verifyRun(run.id, {
        correction: options.correct,
        review: workflowIncludes(options.workflow, "critic"),
      });
      observer?.verificationFinished?.(run.verificationResult?.passed ?? false);
      await flush(task, run);
      if (hasVerify) {
        out(
          run.verificationResult?.passed === true
            ? stepLine("✓", "Verification")
            : stepLine("✗", "Verification", `${failedVerifyNames()} failed`),
        );
      }

      // Lot 6: one bounded correction attempt against the same worktree.
      // (cast: verifyRun mutates run.state past the narrowing above)
      const correctionVerification = session.lastVerification();
      if ((run.state as RunState) === "correcting" && correctionVerification !== undefined) {
        const failedResults = correctionVerification.results.filter(isFailedVerificationResult);
        const failedNames = failedResults.map((result) => result.name);
        const passedNames = correctionVerification.results
          .filter((result) => !result.timedOut && result.exitCode === 0)
          .map((result) => result.name);
        const packet = buildCorrectionPacket(
          task,
          failedResults.map((result) => ({
            name: result.name,
            commandLine: [result.command, ...result.args].join(" "),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
          })),
          passedNames,
        );

        out("\n── correction (attempt 2/2) ──\n");
        out(`verification failed for: ${failedNames.join(", ")}\n`);
        out("sending a correction packet to the same worker\n");
        throwIfAborted();
        out("\n── agent output (attempt 2) ──\n");
        observer?.correctionStarted?.(failedNames);
        await orchestrator.executeCorrection(run.id, packet, executeOptions);
        await flush(task, run);
        out(agentStepLine(run, "Correction (attempt 2)"));

        if ((run.state as RunState) === "correcting") {
          out("\n── verification (attempt 2) ──\n");
          observer?.verificationStarted?.();
          // no correction option: the cap makes this outcome terminal
          await orchestrator.verifyRun(run.id, {
            correction: false,
            review: workflowIncludes(options.workflow, "critic"),
          });
          observer?.verificationFinished?.(run.verificationResult?.passed ?? false);
          await flush(task, run);
          out(
            run.verificationResult?.passed === true
              ? stepLine("✓", "Verification")
              : stepLine("✗", "Verification", `${failedVerifyNames()} failed`),
          );
        }
      }
    }

    // Lot 7: independent read-only reviewer, after the FINAL verification
    // passed. Advisory: findings never affect the exit code.
    if ((run.state as RunState) === "reviewing") {
      out("\n── review ──\n");
      throwIfAborted();
      observer?.reviewStarted?.();
      const diff = run.workspacePath !== undefined ? await getWorktreeDiff(run.workspacePath) : "";
      const packet = buildReviewerPacket({
        task,
        diff,
        verification: (session.lastVerification()?.results ?? []).map((result) => ({
          name: result.name,
          passed: !result.timedOut && result.exitCode === 0,
        })),
      });
      const criticOptions: Parameters<Orchestrator["reviewRun"]>[2] = {
        ...executeOptions,
        target: options.criticTarget ?? options.workerTarget,
      };
      if (options.criticReasoningEffort !== undefined) {
        criticOptions.explicitReasoningEffort = options.criticReasoningEffort;
      } else {
        delete criticOptions.explicitReasoningEffort;
      }
      await orchestrator.reviewRun(run.id, packet, criticOptions);
      await flush(task, run);

      const review = run.review;
      if (review !== undefined) {
        observer?.reviewFinished?.(review);
        if (review.error !== undefined) {
          out(stepLine("•", "Review", `unavailable (advisory): ${review.error}`));
        } else {
          out(stepLine("✓", "Review", findingsSummary(review.findings)));
          for (const finding of review.findings.slice(0, 10)) {
            const location = finding.path !== undefined ? `${finding.path}: ` : "";
            out(`  • [${finding.severity}] ${location}${finding.message}\n`);
          }
          if (review.findings.length > 10) {
            out(`  … +${review.findings.length - 10} more in the run JSON\n`);
          }
        }
      }
    }

    const observerTarget = options.observerTarget;
    const observerUseful =
      observerTarget !== undefined &&
      deps.signal?.aborted !== true &&
      isTerminal(run) &&
      runHasMeaningfulExecution(run);
    if (observerUseful) {
      out("\n── observer ──\n");
      try {
        await orchestrator.observeRun(run.id, {
          timeoutMs: options.timeoutMinutes * 60_000,
          target: observerTarget,
          ...(options.observerReasoningEffort !== undefined
            ? { explicitReasoningEffort: options.observerReasoningEffort }
            : {}),
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          onOutput: (chunk: string, stream: "stdout" | "stderr") => {
            observer?.agentOutput?.(chunk, stream);
            out(chunk);
          },
        });
      } catch (error) {
        run.observer = {
          summary: "",
          findings: [],
          structured: false,
          completedAt: new Date().toISOString(),
          agentResult: {
            exitCode: 1,
            timedOut: false,
            aborted: false,
          },
          error: (error as Error).message,
        };
      }
      await flush(task, run);
      if (run.observer !== undefined) {
        out(
          run.observer.error !== undefined
            ? stepLine("•", "Observer", `unavailable (advisory): ${run.observer.error}`)
            : stepLine("✓", "Observer", `${run.observer.findings.length} finding(s)`),
        );
      }
    } else if (options.observerTarget !== undefined && isTerminal(run)) {
      out("\n── observer ──\n");
      out(stepLine("•", "Observer", "skipped — run failed before meaningful execution"));
    }
  } catch (error) {
    const message = (error as Error).message;
    const aborted = deps.signal?.aborted === true;
    const cancellable =
      run.state === "pending" ||
      run.state === "running" ||
      run.state === "verifying" ||
      run.state === "correcting" ||
      run.state === "reviewing";
    if (aborted && cancellable) {
      // user abort (q / Ctrl-C) at ANY phase: cancel, never fail
      orchestrator.cancelRun(run.id, "cancelled by user");
      out("\n■ cancelled by user\n");
    } else if (run.state === "running" || run.state === "verifying" || run.state === "correcting") {
      orchestrator.failRun(run.id, message);
      out(`\nerror: ${message}\n`);
    } else if (run.state === "pending") {
      orchestrator.cancelRun(run.id, message);
      out(`\nerror: ${message}\n`);
    } else {
      // reviewing / terminal: unexpected, but never crash the summary
      out(`\nerror: ${message}\n`);
    }
    await flush(task, run);
  }

  out("\n── summary ──\n");
  out(`State:     ${run.state.toUpperCase()}\n`);
  out(`Task:      ${task.title}\n`);
  if (brief.source.kind === "file") {
    out(`Brief:     ${brief.source.path}\n`);
  }
  out(`Workflow:  ${options.workflow}\n`);
  out(`Run:       ${run.id}\n`);
  if (run.attempts.length > 0) {
    out(
      `Attempts:  ${run.attempts.length}` +
        `${run.attempts.length > 1 ? " (initial + correction)" : ""}\n`,
    );
  }
  out(`Branch:    ${run.branch ?? "-"}\n`);
  out(`Worktree:  ${run.workspacePath ?? "-"}\n`);
  if (run.result?.summary !== undefined) {
    out(`Agent:     finished — final message:\n  ${run.result.summary.split("\n").join("\n  ")}\n`);
  }
  if (run.result?.error !== undefined) {
    out(`Error:     ${run.result.error}\n`);
  }
  const latestVerification = session.lastVerification();
  if (latestVerification !== undefined) {
    if (latestVerification.results.length === 0) {
      out("Verify:    no verification commands configured\n");
    } else {
      out(`Verify:    ${latestVerification.passed ? "passed" : "FAILED"}\n`);
    }
  }
  if (run.review !== undefined) {
    const review = run.review;
    out(
      `Review:    ${
        review.error !== undefined
          ? `unavailable (advisory): ${review.error}`
          : findingsSummary(review.findings)
      }\n`,
    );
  }
  if (run.observer !== undefined) {
    out(
      `Observer:  ${
        run.observer.error !== undefined
          ? `unavailable (advisory): ${run.observer.error}`
          : `${run.observer.findings.length} finding(s)`
      }\n`,
    );
  }
  const metadataPath = path.join(store.dir, `${run.id}.json`);
  out(`Metadata:  ${metadataPath} (+ .events.jsonl)\n`);

  const cleanupNote = await session.cleanup(run, options.cleanup);
  out(`Cleanup:   ${cleanupNote}\n`);

  const result: RunTaskResult = {
    exitCode: run.state === "completed" ? 0 : 1,
    run,
    task,
    repoRoot,
    storeDir: store.dir,
    cleanupNote,
  };
  if (latestVerification !== undefined) {
    result.verification = latestVerification;
  }
  return result;
}

function isTerminal(run: Run): boolean {
  return run.state === "completed" || run.state === "failed" || run.state === "cancelled";
}

/**
 * True when the run produced facts an Observer can meaningfully interpret.
 * Skipping Observer for pure infrastructure failures (e.g. Driver 529 before
 * any worker ran) avoids extra cost/time repeating the same provider outage.
 */
export function runHasMeaningfulExecution(run: Run): boolean {
  const workerAttempted = (run.invocations ?? []).some(
    (invocation) =>
      invocation.role === "worker" &&
      (invocation.state === "completed" ||
        invocation.state === "failed" ||
        invocation.state === "cancelled"),
  );
  const verificationRan = (run.verificationHistory ?? []).length > 0;
  return workerAttempted || verificationRan;
}
