import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  StaticRuntimeRegistry,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from "../../src/core/index.js";
import { cli } from "../../src/cli/cli.js";
import { inlineBrief } from "../../src/cli/brief.js";
import { runTask, selectedRuntimeTargets } from "../../src/cli/run-command.js";
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

function stubAdapter(
  behavior: StubBehavior,
  options: { id?: string; reasoningEffort?: readonly string[] } = {},
): AgentAdapter {
  return {
    id: options.id ?? "stub-agent",
    capabilities: () => ({
      supportsReadOnly: true,
      supportsStructuredOutput: true,
      reasoningEffort: (options.reasoningEffort ?? [
        "minimal",
        "low",
        "medium",
        "high",
        "maximum",
      ]) as ReturnType<AgentAdapter["capabilities"]>["reasoningEffort"],
    }),
    detect: () => Promise.resolve({ available: true, version: "stub 1.0" }),
    run: async (input) => ({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      ...(await behavior(input)),
    }),
  };
}

function registry(adapter: AgentAdapter = fileCreatingStub) {
  return new StaticRuntimeRegistry([adapter]);
}

function workerTarget(runtime = "stub-agent") {
  return { runtime };
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
      "invocation.created",
      "invocation.started",
      "agent.started",
      "agent.output",
      "agent.completed",
      "invocation.completed",
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

  it("generates structured and human run reports from stored facts", async () => {
    const repo = await makeTempRepo();
    const runIo = capture();

    const code = await cli(
      ["run", "create hello.txt", "--repo", repo, "--verify", "test -f hello.txt"],
      { adapter: fileCreatingStub, out: runIo.out },
    );
    expect(code).toBe(0);
    const [runId] = await storedRunIds(repo);
    expect(runId).toBeDefined();

    const jsonIo = capture();
    const jsonCode = await cli(["report", runId ?? "", "--repo", repo, "--json"], {
      adapter: fileCreatingStub,
      out: jsonIo.out,
    });
    expect(jsonCode).toBe(0);
    const report = JSON.parse(jsonIo.text()) as {
      metrics: { invocationCount: number; usage: { inputTokens: number | null } };
      invocations: {
        role: string;
        permissions: { readOnly: boolean; workspaceWrite: boolean };
        usageKnown: boolean;
      }[];
      acceptanceCoverage: { status: string };
    };
    expect(report.metrics.invocationCount).toBe(1);
    expect(report.metrics.usage.inputTokens).toBeNull();
    expect(report.invocations).toMatchObject([
      {
        role: "worker",
        permissions: { readOnly: false, workspaceWrite: true },
        usageKnown: false,
      },
    ]);
    expect(report.acceptanceCoverage.status).toBe("not_demonstrated");

    const humanIo = capture();
    const humanCode = await cli(["report", runId ?? "", "--repo", repo], {
      adapter: fileCreatingStub,
      out: humanIo.out,
    });
    expect(humanCode).toBe(0);
    expect(humanIo.text()).toContain(`Run #${runId}`);
    expect(humanIo.text()).toContain("readOnly=false workspaceWrite=true");
    expect(humanIo.text()).toContain("coverage           unknown");
    expect(humanIo.text()).toContain("estimated cost known unknown");
    expect(humanIo.text()).toContain("conjunction land");
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
    const instructions: string[] = [];
    // attempt 1 does nothing (verify fails); attempt 2 receives the packet and fixes it
    const fixingStub = stubAdapter(async (input) => {
      instructions.push(input.instructions);
      if (input.instructions.includes("PREVIOUS attempt in this worktree FAILED verification")) {
        await writeFile(path.join(input.workspacePath, "good.txt"), "fixed\n");
      }
      return {};
    });

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--verify", "test -f good.txt"],
      { adapter: fixingStub, out: io.out },
    );

    expect(code).toBe(0);
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toContain("create good.txt");
    expect(instructions[1]).toContain("PREVIOUS attempt in this worktree FAILED verification");
    expect(instructions[1]).toContain("test -f good.txt");
    expect(instructions[1]).toContain("exit 1");
    expect(instructions[1]).toContain("create good.txt"); // original objective carried over

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
    ) as {
      run: {
        state: string;
        attempts: { index: number; correctionPacket?: string }[];
        invocations?: { role: string; readOnly?: boolean }[];
      };
    };
    expect(stored.run.state).toBe("completed");
    expect(stored.run.attempts.map((a) => a.index)).toEqual([1, 2]);
    expect(stored.run.attempts[1]?.correctionPacket).toBe(instructions[1]);
    expect(stored.run.invocations?.map((invocation) => invocation.role)).toEqual([
      "worker",
      "worker",
    ]);

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

  it("lot 7: --review runs the read-only reviewer after verification passes", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const reviewInputs: { readOnly?: boolean; schema?: unknown }[] = [];
    const reviewingStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        reviewInputs.push({ readOnly: input.readOnly, schema: input.outputSchema });
        return {
          lastMessage: JSON.stringify({
            summary: "fine with nits",
            findings: [
              { severity: "major", path: "hello.txt", message: "trailing newline missing" },
              { severity: "nit", message: "consider a shorter greeting" },
            ],
          }),
        };
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hello conjunction\n");
      return {};
    });

    const code = await cli(
      ["run", "create hello.txt", "--repo", repo, "--verify", "test -f hello.txt", "--review"],
      { adapter: reviewingStub, out: io.out },
    );

    expect(code).toBe(0);
    expect(reviewInputs).toHaveLength(1);
    expect(reviewInputs[0]?.readOnly).toBe(true);
    expect(reviewInputs[0]?.schema).toBeDefined();

    const text = io.text();
    expect(text).toContain("── review ──");
    expect(text).toContain("✓ Review");
    expect(text).toContain("2 findings (1 major, 1 nit)");
    expect(text).toContain("• [major] hello.txt: trailing newline missing");
    expect(text).toContain("Review:    2 findings (1 major, 1 nit)");
    expect(text).toContain("State:     COMPLETED");

    // findings persisted on the run JSON + review events in the stream
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { review?: { findings: unknown[]; structured: boolean } } };
    expect(stored.run.review?.structured).toBe(true);
    expect(stored.run.review?.findings).toHaveLength(2);
    const events = await readFile(
      path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`),
      "utf8",
    );
    expect(events).toContain('"review.started"');
    expect(events).toContain('"review.completed"');
    expect(events).toContain('"total":2');

    // status shows the findings count
    const statusIo = capture();
    await cli(["status", "--repo", repo], { out: statusIo.out });
    expect(statusIo.text()).toContain("2 findings");
  });

  it("lot 7: --review works without --verify", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const reviewingStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        return { lastMessage: JSON.stringify({ summary: "ok", findings: [] }) };
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
      return {};
    });
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--review"], {
      adapter: reviewingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("✓ Review");
    expect(io.text()).toContain("no findings");
    expect(io.text()).toContain("State:     COMPLETED");
  });

  it("lot 7: reviewer crash is advisory — run still completes with exit 0", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const crashingReviewerStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        return { exitCode: 1 };
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
      return {};
    });
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--review"], {
      adapter: crashingReviewerStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("• Review");
    expect(io.text()).toContain("unavailable (advisory)");
    expect(io.text()).toContain("State:     COMPLETED");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { state: string; review?: { error?: string } } };
    expect(stored.run.state).toBe("completed");
    expect(stored.run.review?.error).toBe("reviewer exited with code 1");
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
        brief: inlineBrief("wait forever"),
        workflow: "single" as const,
        workerTarget: workerTarget(),
        repoPath: repo,
        verifyCommands: [],
        timeoutMinutes: 5,
        cleanup: false,
        correct: false,
      },
      { runtimeRegistry: registry(waitingStub), out: io.out, signal: controller.signal },
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

describe("cli run — audit error paths", () => {
  it("abort before start: run cancels, agent never called, no worktree created", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const controller = new AbortController();
    controller.abort();
    let agentCalls = 0;
    const countingStub = stubAdapter(() => {
      agentCalls++;
      return Promise.resolve({});
    });
    const result = await runTask(
      {
        brief: inlineBrief("never starts"),
        workflow: "single" as const,
        workerTarget: workerTarget(),
        repoPath: repo,
        verifyCommands: [],
        timeoutMinutes: 5,
        cleanup: false,
        correct: false,
      },
      { runtimeRegistry: registry(countingStub), out: io.out, signal: controller.signal },
    );
    expect(result.exitCode).toBe(1);
    expect(result.run?.state).toBe("cancelled");
    expect(agentCalls).toBe(0);
    expect(io.text()).toContain("cancelled by user");
  });

  it("abort DURING verification: command killed, run cancelled (not failed)", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const controller = new AbortController();
    const slowVerify = {
      name: "slow",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
    };
    const promise = runTask(
      {
        brief: inlineBrief("verify gets cancelled"),
        workflow: "single" as const,
        workerTarget: workerTarget(),
        repoPath: repo,
        verifyCommands: [slowVerify],
        timeoutMinutes: 5,
        cleanup: false,
        correct: false,
      },
      { runtimeRegistry: registry(fileCreatingStub), out: io.out, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 600)); // let verification start
    controller.abort();
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.run?.state).toBe("cancelled");
    expect(io.text()).toContain("cancelled by user");
    expect(io.text()).not.toContain("verification failed");
  });

  it("unwritable .conjunction/runs: run degrades cleanly with a warning", async () => {
    const repo = await makeTempRepo();
    // make the runs dir unpersistable: a FILE named "runs" blocks mkdir
    const conjunctionDir = path.join(repo, ".conjunction");
    await mkdir(conjunctionDir, { recursive: true });
    await writeFile(path.join(conjunctionDir, "runs"), "not a directory\n");

    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(0); // the run itself still completed
    expect(io.text()).toContain("warning: could not persist run metadata");
    expect(io.text()).toContain("State:     COMPLETED");
    // warned exactly once despite several flush points
    expect(io.text().match(/could not persist run metadata/g)).toHaveLength(1);
  });

  it("full chain: verify-fail -> correction -> verify-pass -> review (post-correction diff)", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const reviewPrompts: string[] = [];
    const fixingStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        reviewPrompts.push(input.instructions);
        return { lastMessage: JSON.stringify({ summary: "ok", findings: [] }) };
      }
      if (input.instructions.includes("PREVIOUS attempt in this worktree FAILED verification")) {
        // correction attempt: fix the failure AND add a second file
        await writeFile(path.join(input.workspacePath, "good.txt"), "fixed\n");
        await writeFile(path.join(input.workspacePath, "extra.txt"), "post-correction\n");
      }
      return {};
    });

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--verify", "test -f good.txt", "--review"],
      { adapter: fixingStub, out: io.out },
    );

    expect(code).toBe(0);
    expect(io.text()).toContain("── correction (attempt 2/2) ──");
    expect(io.text()).toContain("── review ──");
    expect(io.text()).toContain("State:     COMPLETED");

    // the reviewer saw the POST-correction diff (both new files present)
    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain("good.txt");
    expect(reviewPrompts[0]).toContain("extra.txt");
    expect(reviewPrompts[0]).toContain("post-correction");

    // persisted: 2 attempts + review, events in the right order
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as {
      run: {
        state: string;
        attempts: unknown[];
        invocations?: { role: string; readOnly?: boolean }[];
        review?: { structured: boolean };
      };
    };
    expect(stored.run.state).toBe("completed");
    expect(stored.run.attempts).toHaveLength(2);
    expect(stored.run.invocations?.map((invocation) => invocation.role)).toEqual([
      "worker",
      "worker",
      "critic",
    ]);
    expect(stored.run.invocations?.[2]?.readOnly).toBe(true);
    expect(stored.run.review?.structured).toBe(true);

    const events = await readFile(
      path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`),
      "utf8",
    );
    const types = events
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types.indexOf("correction.completed")).toBeLessThan(types.indexOf("review.started"));
    expect(types.indexOf("review.completed")).toBeLessThan(types.indexOf("run.completed"));
    expect(types.at(-1)).toBe("run.completed");
  });

  it("lot 2: worker and critic can use distinct runtime targets without mixed output", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const workerInputs: AgentRunInput[] = [];
    const criticInputs: AgentRunInput[] = [];
    const worker = stubAdapter(
      async (input) => {
        workerInputs.push(input);
        input.onOutput?.("worker stdout\n", "stdout");
        await writeFile(path.join(input.workspacePath, "good.txt"), "ok\n");
        return { lastMessage: "worker done" };
      },
      { id: "runtime-a", reasoningEffort: ["high"] },
    );
    const critic = stubAdapter(
      async (input) => {
        criticInputs.push(input);
        input.onOutput?.("critic stderr\n", "stderr");
        return { lastMessage: JSON.stringify({ summary: "ok", findings: [] }) };
      },
      { id: "runtime-b", reasoningEffort: ["maximum"] },
    );

    const code = await cli(
      [
        "run",
        "create good.txt",
        "--repo",
        repo,
        "--workflow",
        "review",
        "--runtime",
        "runtime-a",
        "--model",
        "worker-model",
        "--effort",
        "high",
        "--critic-runtime",
        "runtime-b",
        "--critic-model",
        "critic-model",
        "--critic-effort",
        "maximum",
        "--plain",
      ],
      { runtimeRegistry: new StaticRuntimeRegistry([worker, critic]), out: io.out },
    );

    expect(code).toBe(0);
    expect(workerInputs).toHaveLength(1);
    expect(criticInputs).toHaveLength(1);
    expect(workerInputs[0]?.target).toEqual({ runtime: "runtime-a", model: "worker-model" });
    expect(workerInputs[0]?.reasoningEffort).toBe("high");
    expect(criticInputs[0]?.target).toEqual({ runtime: "runtime-b", model: "critic-model" });
    expect(criticInputs[0]?.reasoningEffort).toBe("maximum");
    expect(criticInputs[0]?.readOnly).toBe(true);

    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as {
      run: {
        invocations?: {
          id: string;
          role: string;
          target: { runtime: string; model?: string };
          reasoningEffort: string;
          readOnly?: boolean;
        }[];
      };
    };
    expect(stored.run.invocations).toMatchObject([
      {
        role: "worker",
        target: { runtime: "runtime-a", model: "worker-model" },
        reasoningEffort: "high",
      },
      {
        role: "critic",
        target: { runtime: "runtime-b", model: "critic-model" },
        reasoningEffort: "maximum",
        readOnly: true,
      },
    ]);

    const events = (
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const outputEvents = events.filter((event) => event.type === "agent.output");
    expect(outputEvents.map((event) => event.payload)).toEqual([
      {
        invocationId: stored.run.invocations?.[0]?.id,
        stream: "stdout",
        chunk: "worker stdout\n",
      },
      {
        invocationId: stored.run.invocations?.[1]?.id,
        stream: "stderr",
        chunk: "critic stderr\n",
      },
    ]);
  });

  it("lot 2: explicit unsupported reasoning effort fails before invoking the runtime", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    let calls = 0;
    const worker = stubAdapter(
      async () => {
        calls++;
        return {};
      },
      { id: "runtime-a", reasoningEffort: ["high"] },
    );

    const code = await cli(
      ["run", "create good.txt", "--repo", repo, "--runtime", "runtime-a", "--effort", "low"],
      { runtimeRegistry: new StaticRuntimeRegistry([worker]), out: io.out },
    );

    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(io.text()).toContain('does not support reasoning effort "low"');
  });
});

describe("cli land", () => {
  /** Runs a task to completion with the given stub, returns the runId. */
  async function completedRun(repo: string, stub = fileCreatingStub): Promise<string> {
    const io = capture();
    const code = await cli(["run", "create hello.txt", "--repo", repo, "--plain"], {
      adapter: stub,
      out: io.out,
    });
    expect(code).toBe(0);
    const [runId] = await storedRunIds(repo);
    expect(runId).toBeDefined();
    return runId ?? "";
  }

  async function storedRun(repo: string, runId: string) {
    return JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as {
      run: {
        state: string;
        baseBranch?: string;
        baseCommit?: string;
        landed?: { targetBranch: string; targetCommit: string; patchPath: string };
      };
    };
  }

  it("happy path: applies changes uncommitted, records landing, works by id prefix", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);

    // base fields were recorded at run start
    const before = await storedRun(repo, runId);
    expect(before.run.baseBranch).toBe("main");
    expect(before.run.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    const io = capture();
    const code = await cli(["land", runId.slice(0, 8), "--repo", repo], { out: io.out });
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toContain("✓ Preflight passed");
    expect(text).toContain("✓ Applied");
    expect(text).toContain("Landed:    main");
    expect(text).toContain("Rollback:  git apply -R");

    // the change landed as UNCOMMITTED content in the user's tree
    expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("hello conjunction\n");
    expect((await execGit(["status", "--porcelain"], { cwd: repo })).stdout).toContain(
      "?? hello.txt",
    );

    // run JSON annotated + event appended
    const after = await storedRun(repo, runId);
    expect(after.run.landed?.targetBranch).toBe("main");
    expect(after.run.landed?.patchPath).toContain(".landing.patch");
    const events = await readFile(
      path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`),
      "utf8",
    );
    expect(events).toContain('"run.landed"');

    // status reflects the landing
    const statusIo = capture();
    await cli(["status", "--repo", repo], { out: statusIo.out });
    expect(statusIo.text()).toContain("landed→main");
  });

  it("refuses to land twice", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);
    expect(await cli(["land", runId, "--repo", repo], { out: capture().out })).toBe(0);
    const io = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io.out })).toBe(1);
    expect(io.text()).toContain("already landed");
  });

  it("refuses non-completed runs", async () => {
    const repo = await makeTempRepo();
    const failingStub = stubAdapter(() => Promise.resolve({ exitCode: 2 }));
    const io0 = capture();
    await cli(["run", "do something", "--repo", repo], { adapter: failingStub, out: io0.out });
    const [runId] = await storedRunIds(repo);

    const io = capture();
    expect(await cli(["land", runId ?? "", "--repo", repo], { out: io.out })).toBe(1);
    expect(io.text()).toContain("only completed runs can be landed");
  });

  it("refuses when the worktree was cleaned up", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);
    const { removeRunWorkspace } = await import("../../src/workspace/index.js");
    await removeRunWorkspace(repo, runId, { force: true });

    const io = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io.out })).toBe(1);
    expect(io.text()).toContain("worktree is gone");
  });

  it("refuses a dirty target tree and names the files", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);
    await writeFile(path.join(repo, "README.md"), "user dirty edit\n");

    const io = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io.out })).toBe(1);
    expect(io.text()).toContain("uncommitted changes");
    expect(io.text()).toContain("README.md");
  });

  it("fails atomically on conflict: target untouched, patch preserved", async () => {
    const repo = await makeTempRepo();
    const editingStub = stubAdapter(async (input) => {
      await writeFile(path.join(input.workspacePath, "README.md"), "agent change\n");
      return {};
    });
    const runId = await completedRun(repo, editingStub);

    // the user diverged AND COMMITTED on the same file after the run started
    await writeFile(path.join(repo, "README.md"), "user committed change\n");
    await execGit(["add", "README.md"], { cwd: repo });
    await execGit(["commit", "-m", "user work"], { cwd: repo });

    const io = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io.out })).toBe(1);
    const text = io.text();
    expect(text).toContain("does not apply cleanly");
    expect(text).toContain("patch was preserved");
    expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("user committed change\n");
  });

  it("old run JSON without baseBranch: refuses without --branch, lands with it", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);

    // simulate a pre-landing run record
    const jsonPath = path.join(repo, ".conjunction", "runs", `${runId}.json`);
    const stored = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, unknown>;
    const run = stored.run as Record<string, unknown>;
    delete run.baseBranch;
    delete run.baseCommit;
    await writeFile(jsonPath, JSON.stringify(stored, null, 2) + "\n");

    const io1 = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io1.out })).toBe(1);
    expect(io1.text()).toContain("pass --branch");

    const io2 = capture();
    expect(await cli(["land", runId, "--repo", repo, "--branch", "main"], { out: io2.out })).toBe(
      0,
    );
    expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("hello conjunction\n");
  });

  it("failed land is non-destructive: run, events, and worktree survive for retry", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);
    const runPath = path.join(repo, ".conjunction", "runs", `${runId}.json`);
    const eventsPath = path.join(repo, ".conjunction", "runs", `${runId}.events.jsonl`);
    const beforeRun = JSON.parse(await readFile(runPath, "utf8")) as {
      run: { landed?: unknown };
    };
    expect(beforeRun.run.landed).toBeUndefined();

    // dirty the main tree so preflight refuses (a failure before any apply)
    await writeFile(path.join(repo, "README.md"), "user dirty edit\n");

    const io1 = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io1.out })).toBe(1);
    expect(io1.text()).toContain("uncommitted changes");

    // run JSON still exists and is untouched
    const afterRun = JSON.parse(await readFile(runPath, "utf8")) as {
      run: { landed?: unknown; state: string };
    };
    expect(afterRun.run.state).toBe("completed");
    expect(afterRun.run.landed).toBeUndefined();

    // events still exist
    expect(await readFile(eventsPath, "utf8")).toContain("run.completed");

    // worktree still exists
    await expect(stat(path.join(repo, ".conjunction", "worktrees", runId))).resolves.toBeDefined();

    // clean the tree and retry successfully
    await execGit(["checkout", "--", "README.md"], { cwd: repo });
    const io2 = capture();
    expect(await cli(["land", runId, "--repo", repo], { out: io2.out })).toBe(0);
    expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("hello conjunction\n");
  });

  it("warns on reviewer error but proceeds (review is advisory)", async () => {
    const repo = await makeTempRepo();
    const crashingReviewerStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        return { exitCode: 1 };
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hello conjunction\n");
      return {};
    });
    const io0 = capture();
    await cli(["run", "create hello.txt", "--repo", repo, "--review"], {
      adapter: crashingReviewerStub,
      out: io0.out,
    });
    const [runId] = await storedRunIds(repo);

    const io = capture();
    const code = await cli(["land", runId ?? "", "--repo", repo], { out: io.out });
    expect(code).toBe(0);
    expect(io.text()).toContain("warning: the reviewer for this run errored");
    expect(io.text()).toContain("✓ Applied");
  });

  it("--cleanup removes worktree and branch after a successful land", async () => {
    const repo = await makeTempRepo();
    const runId = await completedRun(repo);
    const io = capture();
    expect(await cli(["land", runId, "--repo", repo, "--cleanup"], { out: io.out })).toBe(0);
    expect(io.text()).toContain("Cleanup:   worktree and branch removed");
    const { stdout: branches } = await execGit(["branch", "--list"], { cwd: repo });
    expect(branches).not.toContain(`conjunction/${runId}`);
    // the landed change stays
    expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toBe("hello conjunction\n");
  });
});

describe("cli run — briefs", () => {
  const BRIEF = [
    "# ChessQuest",
    "",
    "## Objective",
    "",
    "Teach chess to children aged 7–11.",
    "",
    "## Constraints",
    "",
    "- rules engine outside React components",
  ].join("\n");

  it("positional brief file: full content becomes the objective, path recorded", async () => {
    const repo = await makeTempRepo();
    const briefPath = path.join(repo, "brief.md");
    await writeFile(briefPath, BRIEF, "utf8");
    const io = capture();

    const code = await cli(["run", briefPath, "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: io.out,
    });

    expect(code).toBe(0);
    expect(io.text()).toContain("task:     ChessQuest"); // title from the # heading
    expect(io.text()).toContain(`brief:    ${briefPath}`);
    expect(io.text()).toContain("Workflow:  single");

    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as {
      run: { workflow?: string };
      task: { title: string; objective: string; source?: { kind: string; path?: string } };
    };
    // the brief survives IN FULL in the run metadata
    expect(stored.task.objective).toBe(BRIEF);
    expect(stored.task.title).toBe("ChessQuest");
    expect(stored.task.source).toEqual({ kind: "file", path: briefPath });
    expect(stored.run.workflow).toBe("single");
  });

  it("--brief is equivalent to the positional form", async () => {
    const repo = await makeTempRepo();
    const briefPath = path.join(repo, "spec-without-extension");
    await writeFile(briefPath, BRIEF, "utf8");
    const io = capture();

    const code = await cli(["run", "--brief", briefPath, "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: io.out,
    });

    expect(code).toBe(0);
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { task: { objective: string; source?: { kind: string } } };
    expect(stored.task.objective).toBe(BRIEF);
    expect(stored.task.source?.kind).toBe("file");
  });

  it("the worker prompt carries the brief verbatim under a Brief heading", async () => {
    const repo = await makeTempRepo();
    const briefPath = path.join(repo, "brief.md");
    await writeFile(briefPath, BRIEF, "utf8");
    const io = capture();
    let seenInstructions = "";
    const taskCapturingStub = stubAdapter(async (input) => {
      seenInstructions = input.instructions;
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
      return {};
    });

    await cli(["run", briefPath, "--repo", repo, "--plain"], {
      adapter: taskCapturingStub,
      out: io.out,
    });

    expect(seenInstructions).toContain(`## Brief (${briefPath})`);
    expect(seenInstructions).toContain("Teach chess to children aged 7–11.");
    expect(seenInstructions).toContain("- rules engine outside React components");
    expect(seenInstructions).not.toContain("## Objective\n# ChessQuest"); // not double-nested
  });

  it("the critic packet also carries the brief", async () => {
    const repo = await makeTempRepo();
    const briefPath = path.join(repo, "brief.md");
    await writeFile(briefPath, BRIEF, "utf8");
    const prompts: string[] = [];
    const reviewingStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        prompts.push(input.instructions);
        return { lastMessage: JSON.stringify({ summary: "ok", findings: [] }) };
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
      return {};
    });

    const code = await cli(["run", briefPath, "--repo", repo, "--workflow", "review", "--plain"], {
      adapter: reviewingStub,
      out: capture().out,
    });

    expect(code).toBe(0);
    expect(prompts[0]).toContain("# ChessQuest");
    expect(prompts[0]).toContain("Teach chess to children aged 7–11.");
  });

  it("a missing brief file fails with exit 2 and never runs the agent", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    let agentCalls = 0;
    const countingStub = stubAdapter(() => {
      agentCalls++;
      return Promise.resolve({});
    });

    const code = await cli(["run", "./does-not-exist.md", "--repo", repo], {
      adapter: countingStub,
      out: io.out,
    });

    expect(code).toBe(2);
    expect(io.text()).toContain("brief file not found");
    expect(io.text()).not.toContain("usage:"); // no usage dump for a filesystem problem
    expect(agentCalls).toBe(0);
  });

  it("a directory as brief fails with exit 2", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "--brief", repo, "--repo", repo], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.text()).toContain("is a directory, expected a file");
  });

  it("an empty brief file fails with exit 2", async () => {
    const repo = await makeTempRepo();
    await writeFile(path.join(repo, "empty.md"), "\n\n  \n", "utf8");
    const io = capture();
    const code = await cli(["run", path.join(repo, "empty.md"), "--repo", repo], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.text()).toContain("brief file is empty");
  });

  it("a historic string task still works and records an inline source", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "fix authentication bug", "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("task:     fix authentication bug");
    expect(io.text()).not.toContain("brief:");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { task: { objective: string; source?: { kind: string } } };
    expect(stored.task.objective).toBe("fix authentication bug");
    expect(stored.task.source).toEqual({ kind: "inline" });
  });
});

describe("cli run — workflows", () => {
  const reviewingStub = stubAdapter(async (input) => {
    if (input.readOnly === true) {
      return { lastMessage: JSON.stringify({ summary: "ok", findings: [] }) };
    }
    await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
    return {};
  });

  it("--workflow single is the default and runs no critic", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    let readOnlyCalls = 0;
    const countingStub = stubAdapter(async (input) => {
      if (input.readOnly === true) {
        readOnlyCalls++;
      }
      await writeFile(path.join(input.workspacePath, "hello.txt"), "hi\n");
      return {};
    });

    const code = await cli(["run", "do it", "--repo", repo, "--workflow", "single", "--plain"], {
      adapter: countingStub,
      out: io.out,
    });

    expect(code).toBe(0);
    expect(readOnlyCalls).toBe(0);
    expect(io.text()).not.toContain("── review ──");
    expect(io.text()).toContain("Workflow:  single");
  });

  it("skips observer when the run failed before meaningful execution", async () => {
    const repo = await makeTempRepo();
    const failingStub = stubAdapter(() => Promise.resolve({ exitCode: 1 }));
    const observerStub = stubAdapter(() => Promise.resolve({ exitCode: 0, lastMessage: "{}" }));
    const registry = new StaticRuntimeRegistry([
      { ...failingStub, id: "worker-runtime" },
      { ...observerStub, id: "observer-runtime" },
    ]);
    const io = capture();
    const code = await cli(
      [
        "run",
        "create hello.txt",
        "--repo",
        repo,
        "--plain",
        "--runtime",
        "worker-runtime",
        "--observer-runtime",
        "observer-runtime",
      ],
      { runtimeRegistry: registry, out: io.out },
    );
    expect(code).toBe(1);
    expect(io.text()).toContain("skipped — run failed before meaningful execution");
  });

  it("--workflow review runs the independent critic", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "do it", "--repo", repo, "--workflow", "review", "--plain"], {
      adapter: reviewingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("── review ──");
    expect(io.text()).toContain("Workflow:  review");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { workflow?: string; review?: unknown } };
    expect(stored.run.workflow).toBe("review");
    expect(stored.run.review).toBeDefined();
  });

  it("--review remains an alias for --workflow review", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "do it", "--repo", repo, "--review", "--plain"], {
      adapter: reviewingStub,
      out: io.out,
    });
    expect(code).toBe(0);
    expect(io.text()).toContain("Workflow:  review");
    const [runId] = await storedRunIds(repo);
    const stored = JSON.parse(
      await readFile(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
    ) as { run: { workflow?: string } };
    expect(stored.run.workflow).toBe("review");
  });

  it("selects driver target for quality workflow preflight", () => {
    const options = {
      brief: inlineBrief("test"),
      workflow: "quality" as const,
      workerTarget: { runtime: "codex-cli" },
      driverTarget: { runtime: "claude-code" },
      criticTarget: { runtime: "claude-code" },
      observerTarget: { runtime: "claude-code" },
      repoPath: "/tmp/repo",
      verifyCommands: [],
      timeoutMinutes: 5,
      cleanup: false,
      correct: false,
    };
    const targets = selectedRuntimeTargets(options, options.workflow);
    expect(targets.map((t) => t.role)).toEqual(["driver", "worker", "critic", "observer"]);
    expect(targets[0]?.target).toEqual({ runtime: "claude-code" });
  });

  it("an unknown workflow is a usage error listing the available ones", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "do it", "--repo", repo, "--workflow", "bogus"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.text()).toContain('unknown workflow "bogus"');
    expect(io.text()).toContain("available: single, review, quality");
  });

  it("--review contradicting --workflow single is refused, not silently resolved", async () => {
    const repo = await makeTempRepo();
    const io = capture();
    const code = await cli(["run", "do it", "--repo", repo, "--workflow", "single", "--review"], {
      adapter: fileCreatingStub,
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.text()).toContain("--review contradicts --workflow single");
  });

  it("correction belongs to every workflow; --no-correct is orthogonal to it", async () => {
    const repo = await makeTempRepo();
    let writeCalls = 0;
    const failingStub = stubAdapter((input) => {
      if (input.readOnly !== true) {
        writeCalls++;
      }
      return Promise.resolve({});
    });

    // review workflow, verification fails: still exactly one correction attempt
    const io = capture();
    const code = await cli(
      ["run", "do it", "--repo", repo, "--workflow", "review", "--verify", "false", "--plain"],
      { adapter: failingStub, out: io.out },
    );
    expect(code).toBe(1);
    expect(writeCalls).toBe(2); // initial + the single correction
    expect(io.text()).toContain("── correction (attempt 2/2) ──");

    // same workflow with --no-correct: no correction attempt at all
    const repo2 = await makeTempRepo();
    writeCalls = 0;
    const io2Local = capture();
    const code2 = await cli(
      [
        "run",
        "do it",
        "--repo",
        repo2,
        "--workflow",
        "review",
        "--verify",
        "false",
        "--no-correct",
        "--plain",
      ],
      { adapter: failingStub, out: io2Local.out },
    );
    expect(code2).toBe(1);
    expect(writeCalls).toBe(1);
    expect(io2Local.text()).not.toContain("correction");
  });

  it("status shows the workflow and brief of a recorded run", async () => {
    const repo = await makeTempRepo();
    const briefPath = path.join(repo, "brief.md");
    await writeFile(briefPath, "# Titled Brief\n\nbody\n", "utf8");
    await cli(["run", briefPath, "--repo", repo, "--workflow", "review", "--plain"], {
      adapter: reviewingStub,
      out: capture().out,
    });

    const io = capture();
    expect(await cli(["status", "--repo", repo], { out: io.out })).toBe(0);
    expect(io.text()).toContain("Titled Brief");
    expect(io.text()).toContain("Workflow review");
    expect(io.text()).toContain(`Brief    ${briefPath}`);
  });

  it("status tolerates runs recorded before brief/workflow support", async () => {
    const repo = await makeTempRepo();
    await cli(["run", "legacy task", "--repo", repo, "--plain"], {
      adapter: fileCreatingStub,
      out: capture().out,
    });
    const [runId] = await storedRunIds(repo);
    const jsonPath = path.join(repo, ".conjunction", "runs", `${runId}.json`);
    const stored = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, unknown>;
    delete (stored.run as Record<string, unknown>).workflow;
    delete (stored.task as Record<string, unknown>).source;
    await writeFile(jsonPath, JSON.stringify(stored, null, 2) + "\n");

    const io = capture();
    expect(await cli(["status", "--repo", repo], { out: io.out })).toBe(0);
    expect(io.text()).toContain("legacy task");
    expect(io.text()).not.toContain("Workflow");
    expect(io.text()).not.toContain("Brief");
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
      capabilities: () => ({
        supportsReadOnly: true,
        supportsStructuredOutput: true,
        reasoningEffort: [],
      }),
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
