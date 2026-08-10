import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConjunctionEvent, RunReview } from "../core/index.js";
import {
  applyPatch,
  assertLandPreflight,
  checkPatchApplies,
  findRepoRoot,
  generateLandingPatch,
  getHeadCommit,
  LandError,
  removeRunWorkspace,
} from "../workspace/index.js";

import { RunStore } from "./run-store.js";

export interface LandCommandOptions {
  runId: string;
  repoPath: string;
  /** Explicit landing target; required for runs recorded before baseBranch existed. */
  branch?: string;
  cleanup: boolean;
}

/** Review-gate warnings (user decision: visible, never blocking). */
function reviewWarnings(review: RunReview | undefined): string[] {
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
 * `conjunction land <runId>` — applies a completed run's worktree changes
 * onto the user's branch as UNCOMMITTED changes (docs/land-spec.md,
 * strategy A). Exit codes: 0 landed, 1 refused/failed, 2 usage/setup error.
 */
export async function landCommand(
  options: LandCommandOptions,
  deps: { out: (chunk: string) => void },
): Promise<number> {
  const { out } = deps;

  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.repoPath);
  } catch {
    out(`error: not a git repository: ${options.repoPath}\n`);
    return 2;
  }

  const store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
  const stored = await store.get(options.runId);
  if (stored === undefined) {
    out(`error: no run "${options.runId}" found under ${store.dir}\n`);
    return 2;
  }
  const { run } = stored;

  const refuse = (message: string): number => {
    out(`✗ ${message}\n`);
    return 1;
  };

  if (run.state !== "completed") {
    return refuse(`run is ${run.state.toUpperCase()} — only completed runs can be landed`);
  }
  if (run.landed !== undefined) {
    return refuse(
      `already landed on "${run.landed.targetBranch}" at ${run.landed.landedAt}\n` +
        `  patch: ${run.landed.patchPath}`,
    );
  }
  if (run.workspacePath === undefined) {
    return refuse("run has no recorded worktree — nothing to land");
  }
  const targetBranch = options.branch ?? run.baseBranch;
  if (targetBranch === undefined) {
    return refuse(
      "this run was recorded before landing support (no baseBranch) —\n" +
        "  re-run the task, or pass --branch <target> explicitly",
    );
  }

  const warnings = reviewWarnings(run.review);
  for (const warning of warnings) {
    out(`warning: ${warning}\n`);
  }

  try {
    await assertLandPreflight({ repoRoot, worktreePath: run.workspacePath, targetBranch });
  } catch (error) {
    if (error instanceof LandError) {
      return refuse(error.message);
    }
    throw error;
  }
  out(`✓ Preflight passed          ${targetBranch}, clean tree\n`);

  const patch = await generateLandingPatch(run.workspacePath);
  if (patch.trim().length === 0) {
    return refuse("the worktree has no changes — nothing to land");
  }
  const patchPath = path.join(store.dir, `${run.id}.landing.patch`);
  await writeFile(patchPath, patch, "utf8");
  out(`✓ Patch generated           ${patchPath}\n`);

  try {
    await checkPatchApplies(repoRoot, patchPath);
  } catch (error) {
    if (error instanceof LandError) {
      out(`✗ ${error.message}\n`);
      out(`  the patch was preserved for manual handling: ${patchPath}\n`);
      out(`  (resolve the conflicts by hand, then: git apply --binary ${patchPath})\n`);
      return 1;
    }
    throw error;
  }

  const targetCommit = await getHeadCommit(repoRoot);
  try {
    await applyPatch(repoRoot, patchPath);
  } catch (error) {
    if (error instanceof LandError) {
      out(`✗ ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  out(`✓ Applied                   ${targetBranch} (uncommitted)\n`);

  // record the landing: run JSON annotation + one event in the JSONL stream
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

  let cleanupNote = "worktree preserved (use --cleanup to remove it)";
  if (options.cleanup) {
    // the work is provably landed — the one case where force is justified
    await removeRunWorkspace(repoRoot, run.id, { force: true });
    cleanupNote = "worktree and branch removed";
  }

  out("\n── summary ──\n");
  out(`Run:       ${run.id}\n`);
  out(`Task:      ${stored.task.title}\n`);
  out(`Landed:    ${targetBranch} @ ${targetCommit.slice(0, 8)} (uncommitted changes)\n`);
  out(`Patch:     ${patchPath}\n`);
  out(`Rollback:  git apply -R ${patchPath}\n`);
  for (const warning of warnings) {
    out(`warning:   ${warning}\n`);
  }
  out(`Cleanup:   ${cleanupNote}\n`);
  return 0;
}
