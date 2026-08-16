import path from "node:path";

import type {
  ExecutionTarget,
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
  Orchestrator,
  workflowIncludes,
} from "../core/index.js";
import type {
  CommandResult,
  VerificationCommand,
  VerificationResult,
} from "../verification/index.js";
import { runVerification } from "../verification/index.js";
import {
  createRunWorkspace,
  DirtyWorktreeError,
  findRepoRoot,
  getCurrentBranch,
  getHeadCommit,
  getWorktreeDiff,
  removeRunWorkspace,
} from "../workspace/index.js";

import type { Brief } from "./brief.js";
import { RunStore } from "./run-store.js";
import { findingsSummary, formatDuration } from "./format.js";

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
    return stepLine("✗", label, run.result?.error ?? "failed");
  }
  if (run.state === "cancelled") {
    return stepLine("■", label, "cancelled");
  }
  return stepLine("✓", label, attemptDuration(attempt));
}

export interface SelectedRuntimeTarget {
  role: "worker" | "critic";
  target: ExecutionTarget;
  explicitEffort?: ReasoningEffort;
}

export function selectedRuntimeTargets(
  options: RunTaskOptions,
  includeCritic: boolean,
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
  if (includeCritic) {
    selected.push({
      role: "critic",
      target: options.criticTarget ?? options.workerTarget,
      ...(options.criticReasoningEffort !== undefined
        ? { explicitEffort: options.criticReasoningEffort }
        : {}),
    });
  }
  return selected;
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
  /** Target used for the critic invocation; defaults to the worker target. */
  criticTarget?: ExecutionTarget;
  /** Explicit critic effort intent; default is recorded as medium by core. */
  criticReasoningEffort?: ReasoningEffort;
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
  const { out, observer } = deps;
  const review = workflowIncludes(options.workflow, "critic");
  const selectedTargets = selectedRuntimeTargets(options, review);

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
          `error: runtime "${adapter.id}" does not support reasoning effort ` +
            `"${selected.explicitEffort}" (supported: ${supported.join(", ") || "none"})\n`,
        );
        return { exitCode: 2, repoRoot: "", storeDir: "" };
      }
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

  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.repoPath);
  } catch {
    out(`error: not a git repository: ${options.repoPath}\n`);
    return { exitCode: 2, repoRoot: "", storeDir: "" };
  }

  let lastVerification: VerificationResult | undefined;
  const orchestrator = new Orchestrator({
    workspace: {
      createWorkspace: async (run) => {
        const workspace = await createRunWorkspace(repoRoot, run.id);
        return { workspacePath: workspace.path, branch: workspace.branch };
      },
    },
    verification: {
      verify: async (run) => {
        if (run.workspacePath === undefined) {
          throw new Error("run has no workspace");
        }
        lastVerification = await runVerification(options.verifyCommands, {
          cwd: run.workspacePath,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          onCommandStart: (command) => observer?.commandStarted?.(command),
          onCommandEnd: (command, result) => {
            observer?.commandFinished?.(command, result);
            const status = result.timedOut
              ? "timed out"
              : result.exitCode === 0
                ? `(${formatDuration(result.durationMs)})`
                : `exit ${result.exitCode ?? "null"}`;
            out(
              `  ${result.timedOut || result.exitCode !== 0 ? "✗" : "✓"} ${result.name} ${status}\n`,
            );
          },
        });
        // An abort mid-verification must surface as a CANCELLED run, not a
        // verification failure: throw so verifyRun never transitions and the
        // catch below can cancel from "verifying".
        if (deps.signal?.aborted === true) {
          throw new Error("cancelled by user");
        }
        return lastVerification;
      },
    },
    runtimeRegistry: deps.runtimeRegistry,
  });

  const store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
  let flushedEvents = 0;
  let persistenceWarningShown = false;
  /**
   * Persistence is best-effort: a failing .conjunction/runs dir must not kill
   * the run itself. Warn once, then keep going (degrade cleanly).
   */
  const flush = async (task: Task, run: Run): Promise<void> => {
    try {
      await store.save({ run, task });
      const events = orchestrator.events.all();
      await store.appendEvents(run.id, events.slice(flushedEvents));
      flushedEvents = events.length;
    } catch (error) {
      if (!persistenceWarningShown) {
        persistenceWarningShown = true;
        out(
          `warning: could not persist run metadata to ${store.dir}: ` +
            `${(error as Error).message} (run continues without it)\n`,
        );
      }
    }
  };

  /** Throw before starting a new phase when the user already cancelled. */
  const throwIfAborted = (): void => {
    if (deps.signal?.aborted === true) {
      throw new Error("cancelled by user");
    }
  };

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
      await orchestrator.verifyRun(run.id, { correction: options.correct, review });
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
      if ((run.state as RunState) === "correcting" && lastVerification !== undefined) {
        const failedResults = lastVerification.results.filter(isFailedVerificationResult);
        const failedNames = failedResults.map((result) => result.name);
        const passedNames = lastVerification.results
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
          await orchestrator.verifyRun(run.id, { correction: false, review });
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
        verification: (lastVerification?.results ?? []).map((result) => ({
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
  if (lastVerification !== undefined) {
    if (lastVerification.results.length === 0) {
      out("Verify:    no verification commands configured\n");
    } else {
      out(`Verify:    ${lastVerification.passed ? "passed" : "FAILED"}\n`);
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
  const metadataPath = path.join(store.dir, `${run.id}.json`);
  out(`Metadata:  ${metadataPath} (+ .events.jsonl)\n`);

  let cleanupNote: string;
  if (options.cleanup && run.workspacePath !== undefined) {
    try {
      await removeRunWorkspace(repoRoot, run.id);
      cleanupNote = "worktree and branch removed";
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        cleanupNote =
          "refused — worktree has uncommitted changes; " + `preserved at ${run.workspacePath}`;
      } else {
        cleanupNote = `failed — ${(error as Error).message}`;
      }
    }
  } else {
    cleanupNote = "worktree preserved for inspection (use --cleanup to attempt removal)";
  }
  out(`Cleanup:   ${cleanupNote}\n`);

  const result: RunTaskResult = {
    exitCode: run.state === "completed" ? 0 : 1,
    run,
    task,
    repoRoot,
    storeDir: store.dir,
    cleanupNote,
  };
  if (lastVerification !== undefined) {
    result.verification = lastVerification;
  }
  return result;
}
