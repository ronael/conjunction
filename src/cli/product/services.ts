import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ConjunctionEvent, RunReview } from "../../core/index.js";
import { buildRunReport, formatRunReport } from "../../core/index.js";
import {
  applyPatch,
  assertLandPreflight,
  checkPatchApplies,
  generateLandingPatch,
  generateLandingPatchToFile,
  getHeadCommit,
  LandError,
  removeRunWorkspace,
} from "../../workspace/index.js";

import { RunStore } from "../run-store.js";
import type { StoredRun } from "../run-store.js";

/**
 * Reusable application services behind the CLI `land` / `report` commands and
 * the Composer's Result Actions. They share one business logic — the CLI never
 * shells out to itself, and the Result Actions reuse the exact same functions.
 */

export interface LandOutcome {
  ok: boolean;
  code: number;
  messages: string[];
  warnings: string[];
  /** Set after a successful apply. */
  cleanupNote?: string;
  /** Set when cleanup failed after a successful apply (warning, not a land failure). */
  cleanupError?: boolean;
  error?: string;
}

export function reviewWarnings(review: RunReview | undefined): string[] {
  const warnings: string[] = [];
  if (review?.error !== undefined) {
    warnings.push(
      `the reviewer for this run errored (${review.error}); landing anyway — review is advisory`,
    );
  }
  const critical = review?.findings.filter((finding) => finding.severity === "critical") ?? [];
  if (critical.length > 0) {
    warnings.push(
      `${critical.length} critical finding(s) from the reviewer are unresolved; landing anyway:`,
      ...critical.map((finding) => {
        const location = finding.path !== undefined ? `${finding.path}: ` : "";
        return `  • ${location}${finding.message}`;
      }),
    );
  }
  return warnings;
}

/**
 * Applies a completed run's worktree changes onto the user's branch as
 * UNCOMMITTED changes — the same logic as `conjunction land`. Returns a
 * structured outcome instead of writing to a stream.
 */
export async function landRun(options: {
  repoRoot: string;
  store: RunStore;
  stored: StoredRun;
  targetBranch?: string;
  cleanup: boolean;
}): Promise<LandOutcome> {
  const { repoRoot, store, stored } = options;
  const { run } = stored;
  const messages: string[] = [];
  const refuse = (error: string): LandOutcome => ({
    ok: false,
    code: 1,
    messages,
    warnings: [],
    error,
  });

  if (run.state !== "completed") {
    return refuse(`run is ${run.state.toUpperCase()} — only completed runs can be landed`);
  }
  if (run.landed !== undefined) {
    return refuse(
      `already landed on "${run.landed.targetBranch}" at ${run.landed.landedAt} (patch: ${run.landed.patchPath})`,
    );
  }
  if (run.workspacePath === undefined) {
    return refuse("run has no recorded worktree — nothing to land");
  }
  const targetBranch = options.targetBranch ?? run.baseBranch;
  if (targetBranch === undefined) {
    return refuse(
      "this run was recorded before landing support (no baseBranch) — re-run the task, or pass --branch explicitly",
    );
  }

  const warnings = reviewWarnings(run.review);
  messages.push(...warnings.map((warning) => `warning: ${warning}`));

  try {
    await assertLandPreflight({ repoRoot, worktreePath: run.workspacePath, targetBranch });
  } catch (error) {
    if (error instanceof LandError) {
      return refuse(error.message);
    }
    throw error;
  }

  const patchPath = path.join(store.dir, `${run.id}.landing.patch`);
  try {
    await generateLandingPatchToFile(run.workspacePath, patchPath);
  } catch (error) {
    if (error instanceof LandError) {
      return refuse(error.message);
    }
    throw error;
  }
  const patchStat = await stat(patchPath).catch(() => undefined);
  if (patchStat === undefined || patchStat.size === 0) {
    return refuse("the worktree has no changes — nothing to land");
  }

  try {
    await checkPatchApplies(repoRoot, patchPath);
  } catch (error) {
    if (error instanceof LandError) {
      return {
        ok: false,
        code: 1,
        messages: [
          `✗ ${error.message}`,
          `  the patch was preserved for manual handling: ${patchPath}`,
        ],
        warnings,
        error: error.message,
      };
    }
    throw error;
  }

  const targetCommit = await getHeadCommit(repoRoot);
  try {
    await applyPatch(repoRoot, patchPath);
  } catch (error) {
    if (error instanceof LandError) {
      return refuse(error.message);
    }
    throw error;
  }

  run.landed = {
    landedAt: new Date().toISOString(),
    targetBranch,
    targetCommit,
    patchPath,
  };
  await store.save(stored);
  const event: ConjunctionEvent = {
    id: randomUUID(),
    type: "run.landed",
    timestamp: run.landed.landedAt,
    taskId: run.taskId,
    runId: run.id,
    payload: { targetBranch, targetCommit, patchPath },
  };
  await store.appendEvents(run.id, [event]);

  let cleanupNote = "worktree preserved";
  let cleanupError = false;
  if (options.cleanup) {
    try {
      await removeRunWorkspace(repoRoot, run.id, { force: true });
      cleanupNote = "worktree and branch removed";
    } catch (error) {
      cleanupError = true;
      cleanupNote = `temporary workspace could not be removed: ${(error as Error).message}`;
    }
  }

  return {
    ok: true,
    code: 0,
    messages: [
      `✓ Changes applied`,
      `  ${targetBranch} @ ${targetCommit.slice(0, 8)} (uncommitted changes)`,
      `  rollback: git apply -R ${patchPath}`,
      ...(cleanupError ? [`⚠ ${cleanupNote}`] : []),
    ],
    warnings,
    ...(cleanupNote !== undefined ? { cleanupNote } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  };
}

/** Safe discard of a run's isolated worktree + its conjunction branch. */
export async function discardRun(options: {
  repoRoot: string;
  store: RunStore;
  stored: StoredRun;
}): Promise<{ ok: boolean; messages: string[]; error?: string }> {
  const { repoRoot, store, stored } = options;
  const { run } = stored;
  if (run.workspacePath === undefined) {
    return { ok: false, messages: [], error: "run has no recorded worktree — nothing to discard" };
  }
  // Safety: the worktree path must stay under the run's own worktree root, and
  // removeRunWorkspace only ever touches the conjunction/<runId> branch and the
  // <repoRoot>/.conjunction/worktrees/<runId> path derived from a validated id.
  await removeRunWorkspace(repoRoot, run.id, { force: true });

  // Minimal explicit metadata (annotation, not a state change).
  run.discardedAt = new Date().toISOString();
  await store.save(stored);
  const event: ConjunctionEvent = {
    id: randomUUID(),
    type: "run.discarded",
    timestamp: run.discardedAt,
    taskId: run.taskId,
    runId: run.id,
    payload: { discardedAt: run.discardedAt },
  };
  await store.appendEvents(run.id, [event]);

  return {
    ok: true,
    messages: ["✓ Changes discarded", "  isolated worktree and branch removed"],
  };
}

/** The diff the user inspects — the same source of truth land applies. */
export async function landingDiff(worktreePath: string): Promise<string> {
  const patch = await generateLandingPatch(worktreePath);
  return patch.trim().length > 0 ? patch : "(no changes)";
}

/** Human report text for a stored run — the same source as `conjunction report`. */
export async function runReportText(options: {
  repoRoot: string;
  store: RunStore;
  stored: StoredRun;
  json?: boolean;
}): Promise<string> {
  const events = await options.store.events(options.stored.run.id);
  const report = buildRunReport({
    run: options.stored.run,
    task: options.stored.task,
    events,
  });
  return options.json === true ? JSON.stringify(report, null, 2) : formatRunReport(report);
}
