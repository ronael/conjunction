import path from "node:path";

import type { AgentAdapter, Run, RunState, Task } from "../core/index.js";
import { buildCorrectionPacket, Orchestrator } from "../core/index.js";
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
  removeRunWorkspace,
} from "../workspace/index.js";

import { RunStore } from "./run-store.js";

export interface RunTaskOptions {
  description: string;
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
  commandStarted?(command: VerificationCommand): void;
  commandFinished?(command: VerificationCommand, result: CommandResult): void;
  /** Verification failed and the single correction attempt is starting. */
  correctionStarted?(failedCommands: string[]): void;
}

export interface RunTaskDeps {
  adapter: AgentAdapter;
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
  const { out, adapter, observer } = deps;

  const availability = await adapter.detect();
  if (!availability.available) {
    out(
      `error: agent runtime "${adapter.id}" is not available: ` +
        `${availability.reason ?? "unknown reason"}\n`,
    );
    return { exitCode: 2, repoRoot: "", storeDir: "" };
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
          onCommandStart: (command) => observer?.commandStarted?.(command),
          onCommandEnd: (command, result) => observer?.commandFinished?.(command, result),
        });
        return lastVerification;
      },
    },
    agent: adapter,
  });

  const store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
  let flushedEvents = 0;
  const flush = async (task: Task, run: Run): Promise<void> => {
    await store.save({ run, task });
    const events = orchestrator.events.all();
    await store.appendEvents(run.id, events.slice(flushedEvents));
    flushedEvents = events.length;
  };

  const title =
    options.description.length > 80
      ? `${options.description.slice(0, 77)}...`
      : options.description;
  const task = orchestrator.createTask({ title, objective: options.description });
  const run = orchestrator.createRun(task.id, adapter.id);
  out(`run:    ${run.id}\ntask:   ${task.title}\n`);

  try {
    await orchestrator.startRun(run.id);
    await flush(task, run);
    out(`branch: ${run.branch ?? "-"}\nworktree: ${run.workspacePath ?? "-"}\n`);
    observer?.context?.({ run, task, repoRoot, storeDir: store.dir });
    out("\n--- agent output ---\n");

    const executeOptions: Parameters<Orchestrator["executeRun"]>[1] = {
      timeoutMs: options.timeoutMinutes * 60_000,
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

    if (run.state === "running") {
      out("\n--- verification ---\n");
      observer?.verificationStarted?.();
      // agent finished cleanly; an empty verify list passes trivially
      await orchestrator.verifyRun(run.id, { correction: options.correct });
      await flush(task, run);

      // Lot 6: one bounded correction attempt against the same worktree.
      // (cast: verifyRun mutates run.state past the narrowing above)
      if ((run.state as RunState) === "correcting" && lastVerification !== undefined) {
        const failedResults = lastVerification.results.filter(
          (result) => result.timedOut || result.exitCode !== 0,
        );
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

        out("\n--- correction (attempt 2/2) ---\n");
        out(`verification failed for: ${failedNames.join(", ")}\n`);
        out("sending a correction packet to the same worker\n");
        out("\n--- agent output (attempt 2) ---\n");
        observer?.correctionStarted?.(failedNames);
        await orchestrator.executeCorrection(run.id, packet, executeOptions);
        await flush(task, run);

        if ((run.state as RunState) === "correcting") {
          out("\n--- verification (attempt 2) ---\n");
          observer?.verificationStarted?.();
          // no correction option: the cap makes this outcome terminal
          await orchestrator.verifyRun(run.id, { correction: false });
          await flush(task, run);
        }
      }
    }
  } catch (error) {
    if (run.state === "running" || run.state === "verifying" || run.state === "correcting") {
      orchestrator.failRun(run.id, (error as Error).message);
    } else if (run.state === "pending") {
      orchestrator.cancelRun(run.id, (error as Error).message);
    }
    await flush(task, run);
    out(`\nerror: ${(error as Error).message}\n`);
  }

  out("\n--- summary ---\n");
  out(`run:      ${run.id}\n`);
  out(`state:    ${run.state}\n`);
  if (run.attempts.length > 0) {
    out(
      `attempts: ${run.attempts.length}` +
        `${run.attempts.length > 1 ? " (initial + correction)" : ""}\n`,
    );
  }
  out(`branch:   ${run.branch ?? "-"}\n`);
  out(`worktree: ${run.workspacePath ?? "-"}\n`);
  if (run.result?.summary !== undefined) {
    out(`agent:    finished — final message:\n  ${run.result.summary.split("\n").join("\n  ")}\n`);
  }
  if (run.result?.error !== undefined) {
    out(`error:    ${run.result.error}\n`);
  }
  if (lastVerification !== undefined) {
    if (lastVerification.results.length === 0) {
      out("verify:   no verification commands configured (vacuous pass)\n");
    } else {
      out(`verify:   ${lastVerification.passed ? "passed" : "FAILED"}\n`);
      for (const result of lastVerification.results) {
        const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "null"}`;
        out(`  ${result.name}: ${status} (${result.durationMs}ms)\n`);
      }
    }
  }
  const metadataPath = path.join(store.dir, `${run.id}.json`);
  out(`metadata: ${metadataPath} (+ .events.jsonl)\n`);

  let cleanupNote: string | undefined;
  if (options.cleanup && run.workspacePath !== undefined) {
    try {
      await removeRunWorkspace(repoRoot, run.id);
      cleanupNote = "cleanup:  worktree and branch removed\n";
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        cleanupNote =
          "cleanup:  refused — worktree has uncommitted changes; " +
          `preserved at ${run.workspacePath}\n`;
      } else {
        cleanupNote = `cleanup:  failed — ${(error as Error).message}\n`;
      }
    }
  } else {
    cleanupNote =
      "cleanup:  worktree preserved for inspection (use --cleanup to attempt removal)\n";
  }
  out(cleanupNote);

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
