import { stat } from "node:fs/promises";

import { execGit, getCurrentBranch, type GitError } from "./git.js";
import { getWorktreeStatus } from "./worktree.js";

/**
 * Landing (docs/land-spec.md, strategy A: atomic patch/apply).
 *
 * Leaf module: git operations only, no run/CLI knowledge. The flow:
 * preflight guards -> generate landing patch in the worktree
 * (`git add -N .` + `git diff --binary HEAD`) -> `git apply --check` ->
 * `git apply` on the user's tree. `git apply` is fully atomic: on failure
 * NOTHING is written, and the saved patch supports manual handling or
 * rollback with `git apply -R <patch>`.
 */

/** A landing precondition or apply failure; the message is user-facing. */
export class LandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandError";
  }
}

function asLandError(prefix: string, error: unknown): LandError {
  const gitError = error as GitError;
  const detail = gitError.stderr?.trim() || (error as Error).message;
  return new LandError(`${prefix}:\n${detail}`);
}

export interface LandPreflightInput {
  repoRoot: string;
  worktreePath: string;
  targetBranch: string;
}

/**
 * Enforces the landing preconditions that git itself can check:
 * - the worktree with the run's changes still exists;
 * - the branch checked out at repoRoot IS the requested target branch
 *   (we never check out branches ourselves, and never land onto a different
 *   branch silently);
 * - the target working tree is CLEAN (v1: no landing onto uncommitted user
 *   work, no auto-stash) — offending files are named in the error.
 */
export async function assertLandPreflight(input: LandPreflightInput): Promise<void> {
  const worktreeExists = await stat(input.worktreePath).then(
    () => true,
    () => false,
  );
  if (!worktreeExists) {
    throw new LandError(`the run's worktree is gone — nothing to land: ${input.worktreePath}`);
  }

  const current = await getCurrentBranch(input.repoRoot);
  if (current === "HEAD") {
    throw new LandError(
      `detached HEAD at ${input.repoRoot} — check out "${input.targetBranch}" first`,
    );
  }
  if (current !== input.targetBranch) {
    throw new LandError(
      `wrong branch checked out: "${current}" — ` +
        `land targets "${input.targetBranch}"; check it out first (or pass --branch)`,
    );
  }

  const status = await getWorktreeStatus(input.repoRoot);
  // .conjunction/ holds our own worktrees/metadata and is always dirty-ish
  const offending = status.entries.filter((entry) => !entry.path.startsWith(".conjunction"));
  if (offending.length > 0) {
    const names = offending
      .slice(0, 10)
      .map((entry) => `  ${entry.index}${entry.workTree} ${entry.path}`)
      .join("\n");
    const more = offending.length > 10 ? `\n  … and ${offending.length - 10} more` : "";
    throw new LandError(
      `target tree has uncommitted changes — commit or stash them first:\n${names}${more}`,
    );
  }
}

/**
 * Generates the landing patch inside the worktree: `git add -N .`
 * (intent-to-add, so UNTRACKED files — what agents mostly produce — appear
 * in the diff) followed by `git diff --binary HEAD` (binary content
 * included). Covers new/binary/renamed/deleted files in git-native format.
 * Returns the patch text; "" means the worktree has no changes.
 */
export async function generateLandingPatch(worktreePath: string): Promise<string> {
  await execGit(["add", "-N", "."], { cwd: worktreePath });
  const { stdout } = await execGit(["diff", "--binary", "HEAD"], { cwd: worktreePath });
  return stdout;
}

/**
 * `git apply --binary --check`: refuses atomically and reports the
 * conflicting files. Nothing is written on failure.
 */
export async function checkPatchApplies(repoRoot: string, patchPath: string): Promise<void> {
  try {
    await execGit(["apply", "--binary", "--check", patchPath], { cwd: repoRoot });
  } catch (error) {
    throw asLandError("the patch does not apply cleanly (nothing was written)", error);
  }
}

/** `git apply --binary`: applies the patch to the user's working tree, unstaged. */
export async function applyPatch(repoRoot: string, patchPath: string): Promise<void> {
  try {
    await execGit(["apply", "--binary", patchPath], { cwd: repoRoot });
  } catch (error) {
    // git apply is atomic: a failure here still leaves the tree untouched,
    // but say so explicitly in the message.
    throw asLandError("apply failed — the target tree was left untouched", error);
  }
}
