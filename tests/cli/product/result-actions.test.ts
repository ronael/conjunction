import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Run } from "../../../src/core/index.js";
import { RunStore } from "../../../src/cli/run-store.js";
import { discardRun, landingDiff, landRun } from "../../../src/cli/product/services.js";
import { execGit, createRunWorkspace } from "../../../src/workspace/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "conj-actions-")));
  dirs.push(repo);
  await execGit(["init", "-b", "main"], { cwd: repo });
  await execGit(["config", "user.email", "t@t.dev"], { cwd: repo });
  await execGit(["config", "user.name", "T"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# x\n");
  await execGit(["add", "README.md"], { cwd: repo });
  await execGit(["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function completedRun(runId: string, repoRoot: string, workspacePath: string): Run {
  return {
    id: runId,
    taskId: "task-1",
    runtime: "opencode",
    workflow: "quality",
    createdAt: new Date().toISOString(),
    state: "completed",
    attempts: [],
    branch: `conjunction/${runId}`,
    workspacePath,
    baseBranch: "main",
    driverDecisions: [],
  };
}

describe("Result Action services", () => {
  it("landRun applies changes uncommitted, persists run.landed, and cleans the worktree+branch", async () => {
    const repo = await makeRepo();
    const runId = "aaaa1111-2222-3333-4444-555566667777";
    const workspace = await createRunWorkspace(repo, runId);
    await writeFile(path.join(workspace.path, "composer-test.txt"), "COMPOSER_OK\n");

    const run = completedRun(runId, repo, workspace.path);
    const store = new RunStore(path.join(repo, ".conjunction", "runs"));
    await store.save({
      run,
      task: {
        id: "task-1",
        title: "t",
        objective: "o",
        constraints: [],
        acceptanceCriteria: [],
        status: "completed",
      },
    });

    const outcome = await landRun({
      repoRoot: repo,
      store,
      stored: {
        run,
        task: {
          id: "task-1",
          title: "t",
          objective: "o",
          constraints: [],
          acceptanceCriteria: [],
          status: "completed",
        },
      },
      cleanup: true,
    });
    expect(outcome.ok).toBe(true);

    // applied, uncommitted
    const content = await readFile(path.join(repo, "composer-test.txt"), "utf8");
    expect(content).toBe("COMPOSER_OK\n");
    const { stdout } = await execGit(["status", "--porcelain"], { cwd: repo });
    expect(stdout).toContain("composer-test.txt"); // uncommitted

    // run.landed persisted
    const stored = await store.get(runId);
    expect(stored?.run.landed?.targetBranch).toBe("main");

    // worktree + branch removed
    await expect(readFile(workspace.path, "utf8")).rejects.toThrow();
    const { stdout: branches } = await execGit(["branch", "--list", `conjunction/${runId}`], {
      cwd: repo,
    });
    expect(branches.trim()).toBe("");
  });

  it("a failed land preserves the worktree and returns an actionable outcome", async () => {
    const repo = await makeRepo();
    const runId = "bbbb2222-3333-4444-5555-666677778888";
    const workspace = await createRunWorkspace(repo, runId);
    await writeFile(path.join(workspace.path, "x.txt"), "x\n");

    // dirty the main tree so preflight refuses
    await writeFile(path.join(repo, "README.md"), "# dirty\n");

    const run = completedRun(runId, repo, workspace.path);
    const store = new RunStore(path.join(repo, ".conjunction", "runs"));
    await store.save({
      run,
      task: {
        id: "task-1",
        title: "t",
        objective: "o",
        constraints: [],
        acceptanceCriteria: [],
        status: "completed",
      },
    });

    const outcome = await landRun({
      repoRoot: repo,
      store,
      stored: {
        run,
        task: {
          id: "task-1",
          title: "t",
          objective: "o",
          constraints: [],
          acceptanceCriteria: [],
          status: "completed",
        },
      },
      cleanup: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/uncommitted changes|clean/i);

    // worktree and branch survive the failed land
    await expect(readFile(path.join(workspace.path, "x.txt"), "utf8")).resolves.toBe("x\n");
    const { stdout: branches } = await execGit(["branch", "--list", `conjunction/${runId}`], {
      cwd: repo,
    });
    expect(branches.trim().length).toBeGreaterThan(0);
  });

  it("discardRun removes only the run's worktree and branch, leaving main untouched", async () => {
    const repo = await makeRepo();
    const runId = "cccc3333-4444-5555-6666-777788889999";
    const workspace = await createRunWorkspace(repo, runId);
    await writeFile(path.join(workspace.path, "discard-me.txt"), "bye\n");

    const run = completedRun(runId, repo, workspace.path);
    const store = new RunStore(path.join(repo, ".conjunction", "runs"));
    await store.save({
      run,
      task: {
        id: "task-1",
        title: "t",
        objective: "o",
        constraints: [],
        acceptanceCriteria: [],
        status: "completed",
      },
    });

    const outcome = await discardRun({
      repoRoot: repo,
      store,
      stored: {
        run,
        task: {
          id: "task-1",
          title: "t",
          objective: "o",
          constraints: [],
          acceptanceCriteria: [],
          status: "completed",
        },
      },
    });
    expect(outcome.ok).toBe(true);

    // main untouched, worktree+branch gone, discard annotated
    await expect(readFile(path.join(repo, "discard-me.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(workspace.path, "utf8")).rejects.toThrow();
    const { stdout: branches } = await execGit(["branch", "--list", `conjunction/${runId}`], {
      cwd: repo,
    });
    expect(branches.trim()).toBe("");
    const stored = await store.get(runId);
    expect(stored?.run.discardedAt).toBeDefined();
  });

  it("landingDiff returns the patch that land would apply", async () => {
    const repo = await makeRepo();
    const runId = "dddd4444-5555-6666-7777-88889999aaaa";
    const workspace = await createRunWorkspace(repo, runId);
    await writeFile(path.join(workspace.path, "new.txt"), "hello\n");
    const diff = await landingDiff(workspace.path);
    expect(diff).toContain("new.txt");
    expect(diff).toContain("+hello");
  });
});
