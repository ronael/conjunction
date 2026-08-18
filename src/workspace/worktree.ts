import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { execGit } from "./git.js";

export const BRANCH_PREFIX = "conjunction/";
export const WORKTREE_ROOT_RELATIVE = path.join(".conjunction", "worktrees");
export const EXCLUDE_ENTRY = ".conjunction/";

/** A path argument that could escape the expected worktree root. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** Raised when cleanup is requested for a worktree with uncommitted changes. */
export class DirtyWorktreeError extends Error {
  constructor(
    readonly worktreePath: string,
    readonly status: WorktreeStatus,
  ) {
    super(
      `refusing to remove dirty worktree (pass { force: true } to override): ${worktreePath} ` +
        `(${status.entries.length} uncommitted entr${status.entries.length === 1 ? "y" : "ies"})`,
    );
    this.name = "DirtyWorktreeError";
  }
}

export interface RunWorkspace {
  runId: string;
  branch: string;
  path: string;
}

export interface WorktreeStatusEntry {
  /** Porcelain index (staged) status column, e.g. "M", "A", " ". */
  index: string;
  /** Porcelain worktree (unstaged) status column. */
  workTree: string;
  path: string;
}

export interface WorktreeStatus {
  clean: boolean;
  entries: WorktreeStatusEntry[];
}

// runIds are uuids in practice, but validate defensively: this value ends up
// in a branch name and a filesystem path, so it must not contain separators,
// "..", or git ref metacharacters.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertValidRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new UnsafePathError(
      `unsafe run id for workspace paths/branches: ${JSON.stringify(runId)}`,
    );
  }
}

export function branchNameForRun(runId: string): string {
  assertValidRunId(runId);
  return `${BRANCH_PREFIX}${runId}`;
}

export function worktreePathForRun(repoRoot: string, runId: string): string {
  assertValidRunId(runId);
  const worktreesRoot = path.resolve(repoRoot, WORKTREE_ROOT_RELATIVE);
  const worktreePath = path.resolve(worktreesRoot, runId);
  if (!worktreePath.startsWith(worktreesRoot + path.sep)) {
    throw new UnsafePathError(`worktree path escapes ${worktreesRoot}: ${worktreePath}`);
  }
  return worktreePath;
}

/**
 * Ensures `.conjunction/` is excluded from git status via `.git/info/exclude`,
 * never by touching the user's `.gitignore`. Idempotent: safe to call many
 * times; never duplicates the entry and never removes existing rules.
 */
export async function ensureConjunctionExcluded(repoRoot: string): Promise<void> {
  const { stdout } = await execGit(["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot });
  const excludePath = path.resolve(repoRoot, stdout.trim());
  const gitInfoDir = path.dirname(excludePath);
  await mkdir(gitInfoDir, { recursive: true });
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    // file does not exist yet
  }
  const lines = content.split("\n");
  if (lines.some((line) => line.trim() === EXCLUDE_ENTRY)) {
    return;
  }
  const suffix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${content}${suffix}${EXCLUDE_ENTRY}\n`, "utf8");
}

/**
 * Creates branch `conjunction/<runId>` at HEAD and checks it out in a new
 * worktree at `<repoRoot>/.conjunction/worktrees/<runId>`.
 * Never touches the user's current branch or working tree.
 */
export async function createRunWorkspace(repoRoot: string, runId: string): Promise<RunWorkspace> {
  const branch = branchNameForRun(runId);
  const worktreePath = worktreePathForRun(repoRoot, runId);
  await ensureConjunctionExcluded(repoRoot);
  await execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot });
  return { runId, branch, path: worktreePath };
}

export async function getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  const { stdout } = await execGit(["status", "--porcelain"], { cwd: worktreePath });
  const entries: WorktreeStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    entries.push({
      index: line.charAt(0),
      workTree: line.charAt(1),
      path: line.slice(3),
    });
  }
  return { clean: entries.length === 0, entries };
}

/**
 * Unified diff of the worktree against HEAD — committed AND uncommitted
 * changes, including UNTRACKED files (which plain `git diff HEAD` omits, and
 * which is what agents mostly produce: new files). Untracked files are read
 * from disk and rendered as synthetic new-file diff sections; binary files
 * are listed but not dumped.
 */
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const { stdout: tracked } = await execGit(["diff", "HEAD"], { cwd: worktreePath });
  const { stdout: untrackedRaw } = await execGit(["ls-files", "--others", "--exclude-standard"], {
    cwd: worktreePath,
  });
  const untracked = untrackedRaw.split("\n").filter((line) => line.length > 0);
  if (untracked.length === 0) {
    return tracked;
  }
  const sections = [tracked.trimEnd()];
  for (const file of untracked.sort()) {
    sections.push(await syntheticNewFileDiff(worktreePath, file));
  }
  return sections.filter((section) => section.length > 0).join("\n") + "\n";
}

async function syntheticNewFileDiff(worktreePath: string, file: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path.join(worktreePath, file), "utf8");
  } catch {
    return `# ${file}: unreadable file, contents omitted\n`;
  }
  if (content.includes(String.fromCharCode(0))) {
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n# (binary file, contents omitted)\n`;
  }
  const contentLines = content.trimEnd().split("\n");
  const count = contentLines.length;
  const header =
    `diff --git a/${file} b/${file}\nnew file mode 100644\n` +
    `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${count} @@`;
  return `${header}\n${contentLines.map((line) => `+${line}`).join("\n")}`;
}

export interface CleanupOptions {
  /**
   * Required to remove a worktree that has uncommitted changes.
   * Without it, cleanup of a dirty worktree refuses with DirtyWorktreeError.
   */
  force?: boolean;
}

/**
 * Removes the worktree and branch that a run created.
 *
 * Git-safety contract (enforced here, documented in docs/architecture-review.md):
 * - refuses to remove a dirty worktree unless `force: true`;
 * - only ever deletes the branch `conjunction/<runId>` derived from the run id,
 *   i.e. a branch this module itself created — never the user's current branch;
 * - never merges, never pushes, never runs `reset --hard`;
 * - all paths are derived from a validated run id and stay under
 *   `<repoRoot>/.conjunction/worktrees/`.
 */
export async function removeRunWorkspace(
  repoRoot: string,
  runId: string,
  options: CleanupOptions = {},
): Promise<void> {
  const branch = branchNameForRun(runId);
  const worktreePath = worktreePathForRun(repoRoot, runId);

  // Partial-failure tolerance: an earlier cleanup may have removed the
  // worktree but failed before deleting the branch (or vice versa). Skip
  // whichever half is already done instead of erroring.
  const worktreeExists = await stat(worktreePath).then(
    () => true,
    () => false,
  );

  if (worktreeExists) {
    const status = await getWorktreeStatus(worktreePath);
    if (!status.clean && options.force !== true) {
      throw new DirtyWorktreeError(worktreePath, status);
    }

    const removeArgs = ["worktree", "remove"];
    if (options.force === true) {
      removeArgs.push("--force");
    }
    removeArgs.push(worktreePath);
    await execGit(removeArgs, { cwd: repoRoot });
  }

  // `branch` is always `${BRANCH_PREFIX}${runId}` with a validated run id,
  // so this can only ever target a conjunction-owned branch. The branch is
  // not checked out anywhere once its worktree is removed, so -D is safe.
  const { stdout: existing } = await execGit(["branch", "--list", branch], { cwd: repoRoot });
  if (existing.trim().length > 0) {
    await execGit(["branch", "-D", branch], { cwd: repoRoot });
  }
}
