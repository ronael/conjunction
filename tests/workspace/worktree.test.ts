import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  branchNameForRun,
  createRunWorkspace,
  DirtyWorktreeError,
  ensureConjunctionExcluded,
  execGit,
  findRepoRoot,
  getWorktreeDiff,
  getWorktreeStatus,
  GitError,
  NotAGitRepositoryError,
  removeRunWorkspace,
  UnsafePathError,
  worktreePathForRun,
} from "../../src/workspace/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  // git resolves symlinks (e.g. /var -> /private/var on macOS), so compare
  // against the real path everywhere.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-test-")));
  tempDirs.push(dir);
  return dir;
}

/** Creates a real git repository with one committed file. */
async function makeTempRepo(): Promise<string> {
  const repo = await makeTempDir();
  await execGit(["init", "-b", "main"], { cwd: repo });
  await execGit(["config", "user.email", "test@conjunction.dev"], { cwd: repo });
  await execGit(["config", "user.name", "Conjunction Test"], { cwd: repo });
  await writeFile(path.join(repo, "file.txt"), "initial\n");
  await execGit(["add", "file.txt"], { cwd: repo });
  await execGit(["commit", "-m", "initial commit"], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findRepoRoot", () => {
  it("resolves the repository root from a nested directory", async () => {
    const repo = await makeTempRepo();
    const nested = path.join(repo, "nested", "deeper");
    await mkdir(nested, { recursive: true });
    expect(await findRepoRoot(repo)).toBe(repo);
    expect(await findRepoRoot(nested)).toBe(repo);
  });

  it("throws NotAGitRepositoryError outside a repository", async () => {
    const dir = await makeTempDir();
    await expect(findRepoRoot(dir)).rejects.toThrow(NotAGitRepositoryError);
  });
});

describe("path/branch derivation", () => {
  it("derives branch and worktree path from the run id", async () => {
    const repo = await makeTempRepo();
    expect(branchNameForRun("run-1")).toBe("conjunction/run-1");
    expect(worktreePathForRun(repo, "run-1")).toBe(
      path.join(repo, ".conjunction", "worktrees", "run-1"),
    );
  });

  it.each(["../evil", "a/b", "a b", "a..b", "-x", ""])("rejects unsafe run id %j", (runId) => {
    expect(() => branchNameForRun(runId)).toThrow(UnsafePathError);
    expect(() => worktreePathForRun("/repo", runId)).toThrow(UnsafePathError);
  });
});

describe("createRunWorkspace", () => {
  it("excludes .conjunction from git status via .git/info/exclude", async () => {
    const repo = await makeTempRepo();
    await ensureConjunctionExcluded(repo);

    const excludePath = path.join(repo, ".git", "info", "exclude");
    const exclude = await readFile(excludePath, "utf8");
    expect(exclude).toContain(".conjunction/");

    // .conjunction content must not appear in git status
    await mkdir(path.join(repo, ".conjunction", "runs"), { recursive: true });
    await writeFile(path.join(repo, ".conjunction", "runs", "x.json"), "{}");
    const status = await getWorktreeStatus(repo);
    expect(status.clean).toBe(true);
  });

  it("is idempotent and preserves existing exclude rules", async () => {
    const repo = await makeTempRepo();
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await writeFile(excludePath, "node_modules/\n*.log\n", "utf8");

    await ensureConjunctionExcluded(repo);
    await ensureConjunctionExcluded(repo);

    const exclude = await readFile(excludePath, "utf8");
    expect(exclude).toContain("node_modules/");
    expect(exclude).toContain("*.log");
    expect(exclude.match(/\.conjunction\//g)).toHaveLength(1);
  });

  it("creates branch conjunction/<runId> and a worktree containing HEAD", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-1");

    expect(workspace.branch).toBe("conjunction/run-1");
    expect(workspace.path).toBe(path.join(repo, ".conjunction", "worktrees", "run-1"));

    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).toContain("conjunction/run-1");

    // the worktree is a real checkout of HEAD on the new branch
    const { stdout: head } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace.path,
    });
    expect(head.trim()).toBe("conjunction/run-1");

    // the user's own branch is untouched
    const { stdout: mainHead } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
    });
    expect(mainHead.trim()).toBe("main");

    // the worktree starts clean
    expect((await getWorktreeStatus(workspace.path)).clean).toBe(true);
  });
});

describe("status and diff", () => {
  it("reports uncommitted changes and produces a diff", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-2");

    await writeFile(path.join(workspace.path, "file.txt"), "changed\n");
    await writeFile(path.join(workspace.path, "new.txt"), "new file\n");

    const status = await getWorktreeStatus(workspace.path);
    expect(status.clean).toBe(false);
    expect(status.entries.map((e) => e.path).sort()).toEqual(["file.txt", "new.txt"]);

    const diff = await getWorktreeDiff(workspace.path);
    expect(diff).toContain("-initial");
    expect(diff).toContain("+changed");
  });

  it("includes UNTRACKED files in the diff as synthetic new-file sections", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-u");
    await writeFile(path.join(workspace.path, "created-by-agent.txt"), "hello\nworld\n");

    const diff = await getWorktreeDiff(workspace.path);
    expect(diff).toContain("diff --git a/created-by-agent.txt b/created-by-agent.txt");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/created-by-agent.txt");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
  });

  it("empty worktree produces an empty diff", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-e");
    expect(await getWorktreeDiff(workspace.path)).toBe("");
  });
});

describe("removeRunWorkspace", () => {
  it("removes a clean worktree and its conjunction branch", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-3");

    await removeRunWorkspace(repo, "run-3");

    const { stdout: worktrees } = await execGit(["worktree", "list", "--porcelain"], {
      cwd: repo,
    });
    expect(worktrees).not.toContain(workspace.path);

    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).not.toContain("conjunction/run-3");
    expect(branches).toContain("main");
  });

  it("refuses to remove a dirty worktree without force", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-4");
    await writeFile(path.join(workspace.path, "file.txt"), "dirty\n");

    await expect(removeRunWorkspace(repo, "run-4")).rejects.toThrow(DirtyWorktreeError);

    // nothing was removed: worktree and branch still exist
    const { stdout: worktrees } = await execGit(["worktree", "list", "--porcelain"], {
      cwd: repo,
    });
    expect(worktrees).toContain(workspace.path);
    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).toContain("conjunction/run-4");
  });

  it("removes a dirty worktree when force is true", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-5");
    await writeFile(path.join(workspace.path, "file.txt"), "dirty\n");

    await removeRunWorkspace(repo, "run-5", { force: true });

    const { stdout: worktrees } = await execGit(["worktree", "list", "--porcelain"], {
      cwd: repo,
    });
    expect(worktrees).not.toContain(workspace.path);
    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).not.toContain("conjunction/run-5");
  });

  it("keeps work in the main tree untouched by cleanup", async () => {
    const repo = await makeTempRepo();
    await createRunWorkspace(repo, "run-6");
    await writeFile(path.join(repo, "local-only.txt"), "do not delete\n");

    await removeRunWorkspace(repo, "run-6");

    const status = await getWorktreeStatus(repo);
    expect(status.entries.map((e) => e.path)).toEqual(["local-only.txt"]);
  });

  it("tolerates a partial earlier cleanup (worktree gone, branch left behind)", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-7");
    // simulate: worktree removed, branch deletion never happened
    await execGit(["worktree", "remove", workspace.path], { cwd: repo });

    await removeRunWorkspace(repo, "run-7"); // must delete the leftover branch, not throw

    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).not.toContain("conjunction/run-7");
    expect(branches).toContain("main");
  });

  it("is idempotent: a second cleanup after a full first one is a no-op", async () => {
    const repo = await makeTempRepo();
    await createRunWorkspace(repo, "run-8");
    await removeRunWorkspace(repo, "run-8");
    await expect(removeRunWorkspace(repo, "run-8")).resolves.toBeUndefined();
    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).toContain("main");
  });
});

describe("createRunWorkspace collisions", () => {
  it("fails cleanly with a GitError when the branch/worktree already exists", async () => {
    const repo = await makeTempRepo();
    await createRunWorkspace(repo, "run-dup");
    await expect(createRunWorkspace(repo, "run-dup")).rejects.toThrow(GitError);
    // the original worktree is untouched
    expect((await getWorktreeStatus(worktreePathForRun(repo, "run-dup"))).clean).toBe(true);
  });
});
