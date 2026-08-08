import path from "node:path";

import type { AgentAdapter, Run, Task } from "../core/index.js";
import { Orchestrator } from "../core/index.js";
import type { VerificationCommand, VerificationResult } from "../verification/index.js";
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
}

export interface RunTaskDeps {
  adapter: AgentAdapter;
  out: (chunk: string) => void;
}

/**
 * The Lot 5 vertical slice:
 * task -> worktree -> agent -> verification -> summary, with run metadata and
 * events persisted under `.conjunction/runs/`. Returns the process exit code:
 * 0 when the run completed (agent clean + verification passed/vacuous).
 */
export async function runTask(options: RunTaskOptions, deps: RunTaskDeps): Promise<number> {
  const { out, adapter } = deps;

  const availability = await adapter.detect();
  if (!availability.available) {
    out(
      `error: agent runtime "${adapter.id}" is not available: ` +
        `${availability.reason ?? "unknown reason"}\n`,
    );
    return 2;
  }

  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.repoPath);
  } catch {
    out(`error: not a git repository: ${options.repoPath}\n`);
    return 2;
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
    out("\n--- agent output ---\n");

    await orchestrator.executeRun(run.id, {
      timeoutMs: options.timeoutMinutes * 60_000,
      onOutput: (chunk) => out(chunk),
    });
    await flush(task, run);

    if (run.state === "running") {
      out("\n--- verification ---\n");
      // agent finished cleanly; an empty verify list passes trivially
      await orchestrator.verifyRun(run.id);
      await flush(task, run);
    }
  } catch (error) {
    if (run.state === "running" || run.state === "verifying") {
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
  out(`metadata: ${path.join(store.dir, `${run.id}.json`)} (+ .events.jsonl)\n`);

  if (options.cleanup && run.workspacePath !== undefined) {
    try {
      await removeRunWorkspace(repoRoot, run.id);
      out("cleanup:  worktree and branch removed\n");
    } catch (error) {
      if (error instanceof DirtyWorktreeError) {
        out(
          "cleanup:  refused — worktree has uncommitted changes; " +
            `preserved at ${run.workspacePath}\n`,
        );
      } else {
        out(`cleanup:  failed — ${(error as Error).message}\n`);
      }
    }
  } else {
    out("cleanup:  worktree preserved for inspection (use --cleanup to attempt removal)\n");
  }

  return run.state === "completed" ? 0 : 1;
}
