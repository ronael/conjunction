import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/core/index.js";
import { cli } from "../../src/cli/cli.js";
import { runTask } from "../../src/cli/run-command.js";
import { execGit } from "../../src/workspace/index.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-cli-test-")));
  tempDirs.push(repo);
  await execGit(["init", "-b", "main"], { cwd: repo });
  await execGit(["config", "user.email", "test@conjunction.dev"], { cwd: repo });
  await execGit(["config", "user.name", "Conjunction Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# test repo\n");
  await execGit(["add", "README.md"], { cwd: repo });
  await execGit(["commit", "-m", "initial commit"], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StubBehavior {
  (input: AgentRunInput): Promise<Partial<AgentRunResult>>;
}

function stubAdapter(behavior: StubBehavior): AgentAdapter {
  return {
    id: "stub-agent",
    detect: () => Promise.resolve({ available: true, version: "stub 1.0" }),
    run: async (input) => ({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      ...(await behavior(input)),
    }),
  };
}

/** Stub that acts like a real agent: creates hello.txt inside the worktree. */
const fileCreatingStub = stubAdapter(async (input) => {
  input.onOutput?.("stub: creating hello.txt\n", "stdout");
  await writeFile(path.join(input.workspacePath, "hello.txt"), "hello conjunction\n");
  return { lastMessage: "created hello.txt" };
});

function capture(): { out: (chunk: string) => void; text: () => string } {
  let buffer = "";
  return { out: (chunk) => (buffer += chunk), text: () => buffer };
}

async function storedRunIds(repo: string): Promise<string[]> {
  const dir = path.join(repo, ".conjunction", "runs");
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

describe("cli run (stub adapter, real git repo)", () => {
  it("runs the full slice: worktree -> agent -> verification -> completed", async () => {
    const repo = await makeTempRepo();
    const io = capture();

    const code = await cli(
      ["run", "create hello.txt", "--repo", repo, "--verify", "test -f hello.txt"],
      { adapter: fileCreatingStub, out: io.out },
    );

    expect(code).toBe(0);
    const [runId] = await storedRunIds(repo);
    expect(runId).toBeDefined();

    // worktree preserved with the agent's change inside
    const worktree = path.join(repo, ".conjunction", "worktrees", runId ?? "");
    expect(await readFile(path.join(worktree, "hello.txt"), "utf8")).toBe("hello conjunction\n");

    // branch created
    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).toContain(`conjunction/${runId}`);

    // metadata + events persisted
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { state: string; branch: string }; task: { objective: string } };
    expect(stored.run.state).toBe("completed");
    expect(stored.run.branch).toBe(`conjunction/${runId}`);
    expect(stored.task.objective).toBe("create hello.txt");

    const events = await readFile(
      path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`),
      "utf8",
    );
    const eventTypes = events
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(eventTypes).toEqual([
      "task.created",
      "run.started",
      "workspace.created",
      "agent.started",
      "agent.output",
      "agent.completed",
      "verification.started",
      "verification.passed",
      "run.completed",
    ]);

    // summary mentions the key facts
    const text = io.text();
    expect(text).toContain("State:     COMPLETED");
    expect(text).toContain(`conjunction/${runId}`);
    expect(text).toContain("✓ test -f hello.txt");
    expect(text).toContain("created hello.txt");
    // daytona-style checklist lines
    expect(text).toContain("✓ Workspace ready");
    expect(text).toContain("✓ Agent (attempt 1)");
    expect(text).toContain("✓ Verification");
  });

  it("fails (exit 1) when verification fails, run state recorded as failed", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--verify", "false"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(1);
    expect(io.text()).toContain("Verify:    FAILED");
    expect(io.text()).toContain("State:     FAILED");
    expect(io.text()).toContain("✗ Verification");
    expect(io.text()).toContain("✗ false exit 1");
  });

  it("fails (exit 1) when the agent exits non-zero", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const failingStub = stubAdapter(() => Promise.resolve({ exitCode: 2 }));
    const code = await cli(["run", "do something", "--repo", repo], {
      adapter: failingStub,
      out: io.out,
    });
    expect(code).toBe(1);
    expect(io.text()).toContain("agent exited with code 2");
  });

  it("completes without verification commands (vacuous pass)", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("no verification commands configured");
    // no verification checklist line/section without --verify
    expect(io.text()).not.toContain("── verification ──");
  });

  it("--cleanup refuses to remove the dirty worktree and preserves it", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--cleanup"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("Cleanup:   refused");
    const [runId] = await storedRunIds(repo);
    const worktree = path.join(repo, ".conjunction", "worktrees", runId ?? "");
    expect(await readFile(path.join(worktree, "hello.txt"), "utf8")).toBe("hello conjunction\n");
  });

  it("rejects a non-git directory with exit 2", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-cli-plain-")));
    tempDirs.push(dir);
    const io = capture();
    const code = await cli(["run", "anything", "--repo", dir], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.text()).toContain("not a git repository");
  });

  it("accepts --plain and renders plain output", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("── agent output ──");
    expect(io.text()).toContain("── summary ──");
    expect(io.text()).toContain("State:     COMPLETED");
  });

  it("lot 6: failed verify triggers one correction attempt, then completes", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const packets: (string | undefined)[] = [];
    // attempt 1 does nothing (verify fails); attempt 2 receives the packet and fixes it
    const fixingStub = stubAdapter(async (input) => {
      packets.push(input.correctionPacket);
      if (input.correctionPacket !== undefined) {
        await writeFile(path.join(input.workspacePath, "good.txt"), "fixed\n");
      }
      return {};
    });

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--verify", "test -f good.txt"],
      { adapter: fixingStub, out: io.out },
    );

    expect(code).toBe(0);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toBeUndefined();
    expect(packets[1]).toContain("PREVIOUS attempt in this worktree FAILED verification");
    expect(packets[1]).toContain("test -f good.txt");
    expect(packets[1]).toContain("exit 1");
    expect(packets[1]).toContain("create good.txt"); // original objective carried over

    const text = io.text();
    expect(text).toContain("── correction (attempt 2/2) ──");
    expect(text).toContain("verification failed for: test -f good.txt");
    expect(text).toContain("── verification (attempt 2) ──");
    expect(text).toContain("✓ Correction (attempt 2)");
    expect(text).toContain("Attempts:  2 (initial + correction)");
    expect(text).toContain("State:     COMPLETED");

    // both attempts persisted in the run JSON
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { state: string; attempts: { index: number; correctionPacket?: string }[] } };
    expect(stored.run.state).toBe("completed");
    expect(stored.run.attempts.map((a) => a.index)).toEqual([1, 2]);
    expect(stored.run.attempts[1]?.correctionPacket).toBe(packets[1]);

    // correction events in the JSONL stream
    const events = await readFile(
      path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`),
      "utf8",
    );
    expect(events).toContain('"correction.started"');
    expect(events).toContain('"correction.completed"');
  });

  it("lot 6: --no-correct fails immediately after a failed verify", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    let agentCalls = 0;
    const countingStub = stubAdapter(() => {
      agentCalls++;
      return Promise.resolve({});
    });

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--verify", "test -f good.txt", "--no-correct"],
      { adapter: countingStub, out: io.out },
    );

    expect(code).toBe(1);
    expect(agentCalls).toBe(1);
    expect(io.text()).toContain("State:     FAILED");
    expect(io.text()).not.toContain("correction");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { attempts: unknown[] } };
    expect(stored.run.attempts).toHaveLength(1);
  });

  it("lot 6: correction that still fails ends failed (cap: no third attempt)", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    let agentCalls = 0;
    const neverFixesStub = stubAdapter(() => {
      agentCalls++;
      return Promise.resolve({});
    });

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--verify", "test -f good.txt"],
      { adapter: neverFixesStub, out: io.out },
    );

    expect(code).toBe(1);
    expect(agentCalls).toBe(2); // initial + the single correction, never a third
    expect(io.text()).toContain("State:     FAILED");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { state: string; attempts: unknown[] } };
    expect(stored.run.state).toBe("failed");
    expect(stored.run.attempts).toHaveLength(2);
  });

  it("cancels a running agent through the AbortSignal (q / Ctrl-C path)", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const controller = new AbortController();
    const waitingStub = stubAdapter(
      (input) =>
        new Promise((resolve) => {
          input.signal?.addEventListener("abort", () => resolve({ exitCode: null, aborted: true }));
        }),
    );
    const promise = runTask(
      {
        description: "wait forever",
        repoPath: repo,
        verifyCommands: [],
        timeoutMinutes: 5,
        cleanup: false,
        correct: false,
      },
      { adapter: waitingStub, out: io.out, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.run?.state).toBe("cancelled");
    expect(io.text()).toContain("State:     CANCELLED");
    // metadata on disk also records the cancellation
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { state: string } };
    expect(stored.run.state).toBe("cancelled");
  });
});

describe("cli status / doctor / usage", () => {
  it("status lists recorded runs", async () => {
    const repo = await makeTempRepo();
    const runIo = capture();
    await cli(["run", "create hello.txt", "--repo", repo], {
      adapter: fileCreatingStub,
      out: runIo.out,
    });

    const io = capture();
    const code = await cli(["status", "--repo", repo], { out: io.out });
    expect(code).toBe(0);
    expect(io.text()).toContain("✓");
    expect(io.text()).toContain("COMPLETED");
    expect(io.text()).toContain("stub-agent");
    expect(io.text()).toContain("create hello.txt");
    expect(io.text()).toContain("Branch");
    expect(io.text()).toContain("Worktree");
  });

  it("status on a repo without runs prints a friendly message", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    expect(await cli(["status", "--repo", repo], { out: io.out })).toBe(0);
    expect(io.text()).toContain("no runs found");
  });

  it("doctor reports adapter availability", async () => {
    const io = capture();
    expect(await cli(["doctor"], { adapter: fileCreatingStub, out: io.out })).toBe(0);
    expect(io.text()).toContain("✓ stub-agent — available");

    const down: AgentAdapter = {
      id: "stub-agent",
      detect: () => Promise.resolve({ available: false, reason: "not installed" }),
      run: () => Promise.reject(new Error("should not run")),
    };
    const io2 = capture();
    expect(await cli(["doctor"], { adapter: down, out: io2.out })).toBe(1);
    expect(io2.text()).toContain("✗ stub-agent — not available: not installed");
  });

  it("prints usage and exit 2 for unknown commands and missing description", async () => {
    const io = capture();
    expect(await cli(["frobnicate"], { out: io.out })).toBe(2);
    expect(io.text()).toContain("unknown command");

    const io2 = capture();
    expect(await cli(["run"], { out: io2.out })).toBe(2);
    expect(io2.text()).toContain("requires a task description");
  });
});
