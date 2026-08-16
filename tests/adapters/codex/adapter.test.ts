import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Task } from "../../../src/core/index.js";
import { buildWorkerInstructions } from "../../../src/core/index.js";
import {
  CodexAdapter,
  type ProcessSpawner,
  type SpawnedProcess,
} from "../../../src/adapters/codex/index.js";

import { describeAgentAdapterContract } from "../agent-adapter-contract.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: (NodeJS.Signals | number)[] = [];

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    return true;
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface FakeSpawn {
  spawner: ProcessSpawner;
  calls: { command: string; args: string[]; cwd: string; detached: boolean }[];
  last(): FakeProcess;
}

function fakeSpawn(behavior?: (child: FakeProcess, args: string[]) => void): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const children: FakeProcess[] = [];
  const spawner: ProcessSpawner = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, detached: options.detached });
    const child = new FakeProcess();
    children.push(child);
    if (behavior) {
      // async so the adapter can attach its listeners first
      queueMicrotask(() => behavior(child, [...args]));
    }
    return child;
  };
  return {
    spawner,
    calls,
    last: () => {
      const child = children.at(-1);
      if (!child) {
        throw new Error("no process spawned");
      }
      return child;
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add hello file",
    objective: "Create hello.txt containing hello conjunction",
    constraints: ["no new dependencies"],
    acceptanceCriteria: ["hello.txt exists"],
    status: "pending",
    ...overrides,
  };
}

describeAgentAdapterContract("CodexAdapter", {
  makeSubject: (options = {}) => {
    const fake = fakeSpawn((child, args) => options.behavior?.(child, args));
    return {
      adapter: new CodexAdapter({
        spawner: fake.spawner,
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
      }),
      calls: fake.calls,
      lastProcess: fake.last,
    };
  },
  promptFromCall: (call) => call.args[call.args.indexOf("--") + 1],
  sandboxFromCall: (call) => call.args[call.args.indexOf("-s") + 1],
});

const baseInput = {
  instructions: buildWorkerInstructions(makeTask()),
  workspacePath: "/tmp/worktree",
  timeoutMs: 1_000,
};

describe("buildWorkerInstructions", () => {
  it("includes objective, constraints, acceptance criteria and workspace rules", () => {
    const prompt = buildWorkerInstructions(makeTask());
    expect(prompt).toContain("Create hello.txt containing hello conjunction");
    expect(prompt).toContain("- no new dependencies");
    expect(prompt).toContain("- hello.txt exists");
    expect(prompt).toContain("isolated git worktree");
    expect(prompt).toContain("Do not run any git commands");
  });

  it("handles empty constraint/criteria lists and optional fields deterministically", () => {
    const prompt = buildWorkerInstructions(makeTask({ constraints: [], acceptanceCriteria: [] }));
    expect(prompt).toContain("- None specified.");
    expect(prompt).toContain("- The objective above is fulfilled.");
    expect(prompt).not.toContain("Relevant paths");

    const withOptionals = buildWorkerInstructions(
      makeTask({ relevantPaths: ["src/"], verificationExpectations: ["pnpm test passes"] }),
    );
    expect(withOptionals).toContain("- src/");
    expect(withOptionals).toContain("- pnpm test passes");
  });
});

describe("CodexAdapter.run invocation", () => {
  it("spawns codex exec sandboxed to the worktree, never a shell", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    await adapter.run(baseInput);

    const call = fake.calls[0];
    expect(call?.command).toBe("codex");
    expect(call?.cwd).toBe("/tmp/worktree");
    expect(call?.detached).toBe(true);

    const args = call?.args ?? [];
    expect(args[0]).toBe("exec");
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe("/tmp/worktree");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--color");
    expect(args[args.indexOf("-o") + 1]).toMatch(/conjunction-codex-/);
    // prompt is passed as a single positional arg after "--"
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(args[separator + 1]).toContain("## Objective");
    // hard safety: never an unsandboxed mode
    expect(args.join(" ")).not.toContain("danger-full-access");
    expect(args.join(" ")).not.toContain("dangerously-bypass");
  });

  it("passes the model override when configured", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = new CodexAdapter({ spawner: fake.spawner, model: "gpt-5-codex" });
    await adapter.run(baseInput);
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5-codex");
  });
});

describe("CodexAdapter.run behavior", () => {
  it("streams stdout and stderr chunks to onOutput", async () => {
    const fake = fakeSpawn((child) => {
      child.stdout.write("hello ");
      child.stderr.write("warn\n");
      child.stdout.write("world");
      child.exit(0);
    });
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    const chunks: [string, string][] = [];
    await adapter.run({ ...baseInput, onOutput: (chunk, stream) => chunks.push([chunk, stream]) });
    expect(chunks).toEqual([
      ["hello ", "stdout"],
      ["warn\n", "stderr"],
      ["world", "stdout"],
    ]);
  });

  it("maps exit codes verbatim", async () => {
    const fake = fakeSpawn((child) => child.exit(3));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    const result = await adapter.run(baseInput);
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false });
  });

  it("reads the final agent message from the -o file", async () => {
    const fake = fakeSpawn((child, args) => {
      const file = args[args.indexOf("-o") + 1];
      void writeFile(file ?? "", "created hello.txt\n").then(() => child.exit(0));
    });
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    const result = await adapter.run(baseInput);
    expect(result.lastMessage).toBe("created hello.txt");
  });

  it("times out, kills the process tree, and reports timedOut", async () => {
    const fake = fakeSpawn(); // never exits on its own
    const adapter = new CodexAdapter({ spawner: fake.spawner, killGraceMs: 10 });
    const promise = adapter.run({ ...baseInput, timeoutMs: 30 });
    // simulate the OS reaping the child after the kill
    setTimeout(() => fake.last().exit(null), 60);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(fake.last().killedWith.length).toBeGreaterThan(0);
  });

  it("honors AbortSignal and reports aborted", async () => {
    const fake = fakeSpawn();
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    const controller = new AbortController();
    const promise = adapter.run({ ...baseInput, signal: controller.signal });
    controller.abort();
    setTimeout(() => fake.last().exit(null), 20);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("reports a spawn failure as exitCode null with a stderr chunk", async () => {
    const fake = fakeSpawn((child) => child.emit("error", new Error("spawn codex ENOENT")));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    const chunks: string[] = [];
    const result = await adapter.run({
      ...baseInput,
      onOutput: (chunk, stream) => {
        if (stream === "stderr") {
          chunks.push(chunk);
        }
      },
    });
    expect(result.exitCode).toBeNull();
    expect(chunks.join("")).toContain("spawn codex ENOENT");
  });
});

describe("CodexAdapter reviewer modes (lot 7)", () => {
  it("readOnly maps to -s read-only and never workspace-write", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    await adapter.run({ ...baseInput, readOnly: true });
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args.join(" ")).not.toContain("workspace-write");
    expect(args.join(" ")).not.toContain("danger-full-access");
  });

  it("uses the caller-prepared instructions verbatim", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    await adapter.run({ ...baseInput, instructions: "THE PACKET" });
    const args = fake.calls[0]?.args ?? [];
    const prompt = args[args.indexOf("--") + 1];
    expect(prompt).toBe("THE PACKET");
    expect(prompt).not.toContain("## Objective");
  });

  it("outputSchema writes a temp schema file and passes --output-schema", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    let schemaContent = "";
    const fake = fakeSpawn((child, args) => {
      const file = args[args.indexOf("--output-schema") + 1] ?? "";
      schemaContent = readFileSync(file, "utf8"); // still exists at spawn time
      child.exit(0);
    });
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    await adapter.run({ ...baseInput, outputSchema: schema });
    const args = fake.calls[0]?.args ?? [];
    expect(args).toContain("--output-schema");
    expect(JSON.parse(schemaContent)).toEqual(schema);
  });

  it("omits --output-schema when no schema is given", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = new CodexAdapter({ spawner: fake.spawner });
    await adapter.run(baseInput);
    expect(fake.calls[0]?.args).not.toContain("--output-schema");
  });
});

describe("CodexAdapter.detect", () => {
  it("reports available with version", async () => {
    const adapter = new CodexAdapter({
      probeVersion: () => Promise.resolve("codex-cli 0.144.1"),
    });
    expect(await adapter.detect()).toEqual({ available: true, version: "codex-cli 0.144.1" });
  });

  it("reports unavailable with the reason", async () => {
    const adapter = new CodexAdapter({
      probeVersion: () => Promise.reject(new Error("ENOENT")),
    });
    const result = await adapter.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("ENOENT");
  });
});
