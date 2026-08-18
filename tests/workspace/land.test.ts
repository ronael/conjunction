import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyPatch,
  assertLandPreflight,
  checkPatchApplies,
  createRunWorkspace,
  execGit,
  generateLandingPatch,
  generateLandingPatchToFile,
  getWorktreeStatus,
  LandError,
} from "../../src/workspace/index.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-land-test-")));
  tempDirs.push(repo);
  await execGit(["init", "-b", "main"], { cwd: repo });
  await execGit(["config", "user.email", "test@conjunction.dev"], { cwd: repo });
  await execGit(["config", "user.name", "Conjunction Test"], { cwd: repo });
  await writeFile(path.join(repo, "file.txt"), "initial\n");
  await writeFile(path.join(repo, "to-delete.txt"), "gone soon\n");
  await execGit(["add", "."], { cwd: repo });
  await execGit(["commit", "-m", "initial commit"], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Worktree with: tracked edit, deleted file, new text file, new binary file. */
async function makeRichWorktree(repo: string, runId: string) {
  const workspace = await createRunWorkspace(repo, runId);
  await writeFile(path.join(workspace.path, "file.txt"), "changed by agent\n");
  await execGit(["rm", "-q", "to-delete.txt"], { cwd: workspace.path });
  await writeFile(path.join(workspace.path, "new.txt"), "brand new\n");
  await writeFile(path.join(workspace.path, "blob.dat"), Buffer.from([0x00, 0x42, 0x00, 0xff]));
  return workspace;
}

describe("generateLandingPatch", () => {
  it("covers modifications, deletions, new text and new binary files", async () => {
    const repo = await makeTempRepo();
    const workspace = await makeRichWorktree(repo, "run-1");
    const patch = await generateLandingPatch(workspace.path);

    expect(patch).toContain("diff --git a/file.txt b/file.txt");
    expect(patch).toContain("-initial");
    expect(patch).toContain("+changed by agent");
    expect(patch).toContain("diff --git a/to-delete.txt b/to-delete.txt");
    expect(patch).toContain("deleted file mode");
    expect(patch).toContain("diff --git a/new.txt b/new.txt");
    expect(patch).toContain("new file mode");
    expect(patch).toContain("diff --git a/blob.dat b/blob.dat");
    expect(patch).toContain("GIT binary patch");
  });

  it("returns an empty patch for a clean worktree", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-2");
    expect((await generateLandingPatch(workspace.path)).trim()).toBe("");
  });

  it("streams a large patch directly to a file without buffering it in memory", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-big");
    // ~20 MiB of new text, enough to exceed the old 16 MiB exec buffer
    const big = "x".repeat(20 * 1024 * 1024);
    await writeFile(path.join(workspace.path, "big.txt"), big);
    const patchPath = path.join(repo, ".conjunction", "big.landing.patch");

    await generateLandingPatchToFile(workspace.path, patchPath);

    const patch = await readFile(patchPath, "utf8");
    expect(patch.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(patch).toContain("diff --git a/big.txt b/big.txt");
    expect(patch).toContain(`+${big.slice(0, 100)}`);
  });
});

describe("assertLandPreflight", () => {
  it("passes on a clean target tree with the right branch", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-3");
    await expect(
      assertLandPreflight({ repoRoot: repo, worktreePath: workspace.path, targetBranch: "main" }),
    ).resolves.toBeUndefined();
  });

  it("refuses when the worktree is gone", async () => {
    const repo = await makeTempRepo();
    await expect(
      assertLandPreflight({
        repoRoot: repo,
        worktreePath: path.join(repo, ".conjunction", "worktrees", "nope"),
        targetBranch: "main",
      }),
    ).rejects.toThrow(/worktree is gone/);
  });

  it("refuses on the wrong checked-out branch", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-4");
    await expect(
      assertLandPreflight({ repoRoot: repo, worktreePath: workspace.path, targetBranch: "other" }),
    ).rejects.toThrow(/wrong branch checked out: "main"/);
  });

  it("refuses a dirty target tree and names the offending files", async () => {
    const repo = await makeTempRepo();
    const workspace = await createRunWorkspace(repo, "run-5");
    await writeFile(path.join(repo, "file.txt"), "user edit\n");
    await writeFile(path.join(repo, "user-note.md"), "mine\n");

    const error = await assertLandPreflight({
      repoRoot: repo,
      worktreePath: workspace.path,
      targetBranch: "main",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LandError);
    expect((error as LandError).message).toContain("uncommitted changes");
    expect((error as LandError).message).toContain("file.txt");
    expect((error as LandError).message).toContain("user-note.md");
    // .conjunction/ itself must NOT count as dirty
    expect((error as LandError).message).not.toContain(".conjunction");
  });
});

describe("apply flow", () => {
  it("applies the patch to the target tree as uncommitted changes", async () => {
    const repo = await makeTempRepo();
    const workspace = await makeRichWorktree(repo, "run-6");
    const patch = await generateLandingPatch(workspace.path);
    const patchPath = path.join(repo, ".conjunction", "landing.patch");
    await writeFile(patchPath, patch);

    const { stdout: headBefore } = await execGit(["rev-parse", "HEAD"], { cwd: repo });
    await applyPatch(repo, patchPath);

    expect(await readFile(path.join(repo, "file.txt"), "utf8")).toBe("changed by agent\n");
    expect(await readFile(path.join(repo, "new.txt"), "utf8")).toBe("brand new\n");
    expect(
      (await readFile(path.join(repo, "blob.dat"))).equals(Buffer.from([0x00, 0x42, 0x00, 0xff])),
    ).toBe(true);
    await expect(stat(path.join(repo, "to-delete.txt"))).rejects.toThrow();
    // unstaged: worktree-only changes, HEAD did not move
    const status = await getWorktreeStatus(repo);
    expect(status.clean).toBe(false);
    expect((await execGit(["rev-parse", "HEAD"], { cwd: repo })).stdout).toBe(headBefore);
  });

  it("check fails atomically on a diverged tree and leaves it untouched", async () => {
    const repo = await makeTempRepo();
    const workspace = await makeRichWorktree(repo, "run-7");
    const patch = await generateLandingPatch(workspace.path);
    const patchPath = path.join(repo, ".conjunction", "landing.patch");
    await writeFile(patchPath, patch);

    // the user diverged on the same file the patch modifies
    await writeFile(path.join(repo, "file.txt"), "user diverged\n");
    await expect(checkPatchApplies(repo, patchPath)).rejects.toThrow(/does not apply cleanly/);
    // atomic: file.txt kept the user's edit, no new files appeared
    expect(await readFile(path.join(repo, "file.txt"), "utf8")).toBe("user diverged\n");
    await expect(stat(path.join(repo, "new.txt"))).rejects.toThrow();
  });
});
