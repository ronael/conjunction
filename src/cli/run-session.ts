import path from "node:path";

import type { Run, Task } from "../core/index.js";
import { Orchestrator } from "../core/index.js";
import type { VerificationResult } from "../verification/index.js";
import { runVerification } from "../verification/index.js";
import {
  createRunWorkspace,
  DirtyWorktreeError,
  findRepoRoot,
  removeRunWorkspace,
} from "../workspace/index.js";

import { formatDuration } from "./format.js";
import { RunStore } from "./run-store.js";
import type { RunTaskDeps, RunTaskOptions } from "./run-command.js";

export interface RunExecutionSession {
  readonly repoRoot: string;
  readonly orchestrator: Orchestrator;
  readonly store: RunStore;
  readonly lastVerification: () => VerificationResult | undefined;
  flush(task: Task, run: Run): Promise<void>;
  throwIfAborted(): void;
  cleanup(run: Run, enabled: boolean): Promise<string>;
}

export async function createRunExecutionSession(
  options: Pick<RunTaskOptions, "repoPath" | "verifyCommands">,
  deps: Pick<RunTaskDeps, "runtimeRegistry" | "out" | "observer" | "signal">,
  rendering?: { failedCommandSymbol?: string },
): Promise<RunExecutionSession> {
  const repoRoot = await findRepoRoot(options.repoPath);
  const store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
  let lastVerification: VerificationResult | undefined;
  let flushedEvents = 0;
  let persistenceWarningShown = false;
  const failedCommandSymbol = rendering?.failedCommandSymbol ?? "✗";

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
          onCommandStart: (command) => deps.observer?.commandStarted?.(command),
          onCommandEnd: (command, result) => {
            deps.observer?.commandFinished?.(command, result);
            const status = result.timedOut
              ? "timed out"
              : result.exitCode === 0
                ? `(${formatDuration(result.durationMs)})`
                : `exit ${result.exitCode ?? "null"}`;
            deps.out(
              `  ${
                result.timedOut || result.exitCode !== 0 ? failedCommandSymbol : "✓"
              } ${result.name} ${status}\n`,
            );
          },
        });
        if (deps.signal?.aborted === true) {
          throw new Error("cancelled by user");
        }
        return lastVerification;
      },
    },
    runtimeRegistry: deps.runtimeRegistry,
  });

  return {
    repoRoot,
    orchestrator,
    store,
    lastVerification: () => lastVerification,
    flush: async (task, run) => {
      try {
        await store.save({ run, task });
        const events = orchestrator.events.all();
        await store.appendEvents(run.id, events.slice(flushedEvents));
        flushedEvents = events.length;
      } catch (error) {
        if (!persistenceWarningShown) {
          persistenceWarningShown = true;
          deps.out(
            `warning: could not persist run metadata to ${store.dir}: ` +
              `${(error as Error).message} (run continues without it)\n`,
          );
        }
      }
    },
    throwIfAborted: () => {
      if (deps.signal?.aborted === true) {
        throw new Error("cancelled by user");
      }
    },
    cleanup: async (run, enabled) => {
      if (enabled && run.workspacePath !== undefined) {
        try {
          await removeRunWorkspace(repoRoot, run.id);
          return "worktree and branch removed";
        } catch (error) {
          if (error instanceof DirtyWorktreeError) {
            return `refused — worktree has uncommitted changes; preserved at ${run.workspacePath}`;
          }
          return `failed — ${(error as Error).message}`;
        }
      }
      return "worktree preserved for inspection (use --cleanup to attempt removal)";
    },
  };
}
