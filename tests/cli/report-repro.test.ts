import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildRunReport,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
  type Run,
  type Task,
} from "../../src/core/index.js";
import { cli } from "../../src/cli/cli.js";
import { RunStore } from "../../src/cli/run-store.js";
import { execGit } from "../../src/workspace/index.js";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "conjunction-report-repro-")));
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

async function storedRunIds(repo: string): Promise<string[]> {
  const dir = path.join(repo, ".conjunction", "runs");
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

const fileCreatingStub: AgentAdapter = {
  id: "stub-agent",
  capabilities: () => ({
    supportsReadOnly: true,
    supportsStructuredOutput: true,
    reasoningEffort: ["minimal", "low", "medium", "high", "maximum"],
  }),
  detect: () => Promise.resolve({ available: true, version: "stub 1.0" }),
  run: async (input: AgentRunInput) => {
    await writeFile(path.join(input.workspacePath, "hello.txt"), "hello conjunction\n");
    return {
      exitCode: 0,
      timedOut: false,
      aborted: false,
      lastMessage: "created hello.txt",
    } satisfies AgentRunResult;
  },
};

describe("report reproducibility from RunStore", () => {
  it("rebuilds the same report after destroying in-memory state", async () => {
    const repo = await makeTempRepo();
    const runIo = {
      buffer: "",
      out(chunk: string) {
        this.buffer += chunk;
      },
    };

    const code = await cli(
      ["run", "create hello.txt", "--repo", repo, "--verify", "test -f hello.txt"],
      { adapter: fileCreatingStub, out: runIo.out.bind(runIo) },
    );
    expect(code).toBe(0);
    const [runId] = await storedRunIds(repo);
    expect(runId).toBeDefined();

    // Build the report from the live CLI session's in-memory state.
    const reportIo = {
      buffer: "",
      out(chunk: string) {
        this.buffer += chunk;
      },
    };
    const reportCode = await cli(["report", runId ?? "", "--repo", repo, "--json"], {
      adapter: fileCreatingStub,
      out: reportIo.out.bind(reportIo),
    });
    expect(reportCode).toBe(0);
    const firstReport = JSON.parse(reportIo.buffer);

    // Destroy in-memory state: load from disk through a fresh RunStore.
    const store = new RunStore(path.join(repo, ".conjunction", "runs"));
    const stored = (await store.get(runId ?? "")) as { run: Run; task: Task };
    const events = await store.events(stored.run.id);
    const secondReport = buildRunReport({ run: stored.run, task: stored.task, events });

    expect(secondReport).toEqual(firstReport);
    expect(secondReport.metrics.usage.coverage).toBe("unknown");
    expect(secondReport.acceptanceCoverage.status).toBe("not_demonstrated");
  });
});
