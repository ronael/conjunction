import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ClaudeAdapter, type ClaudeAdapterOptions } from "../../../src/adapters/claude/index.js";
import type { ProcessSpawner, SpawnedProcess } from "../../../src/adapters/process.js";

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

function makeAdapter(options: ClaudeAdapterOptions): ClaudeAdapter {
  return new ClaudeAdapter(options);
}

describeAgentAdapterContract("ClaudeAdapter", {
  makeSubject: (options = {}) => {
    const fake = fakeSpawn((child, args) => options.behavior?.(child, args));
    return {
      adapter: makeAdapter({
        spawner: fake.spawner,
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
      }),
      calls: fake.calls,
      lastProcess: fake.last,
    };
  },
  promptFromCall: (call) => call.args.at(-1),
  assertReadOnlyTransport: (call) => {
    expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,LS");
  },
});

const baseInput = {
  target: { runtime: "claude-code" },
  reasoningEffort: "medium" as const,
  instructions: "Review the diff",
  workspacePath: "/tmp/worktree",
  timeoutMs: 1_000,
};

describe("ClaudeAdapter.run invocation", () => {
  it("spawns claude print mode in the worktree, never a shell", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = makeAdapter({ spawner: fake.spawner });
    await adapter.run(baseInput);

    const call = fake.calls[0];
    expect(call?.command).toBe("claude");
    expect(call?.cwd).toBe("/tmp/worktree");
    expect(call?.detached).toBe(true);

    const args = call?.args ?? [];
    expect(args).toContain("-p");
    expect(args[args.indexOf("--output-format") + 1]).toBe("text");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args.at(-1)).toBe("Review the diff");
    expect(args.join(" ")).not.toContain("dangerously");
  });

  it("passes model and maps supported reasoning effort", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = makeAdapter({ spawner: fake.spawner });
    await adapter.run({
      ...baseInput,
      target: { runtime: "claude-code", model: "sonnet" },
      reasoningEffort: "maximum",
    });
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });

  it("does not fake unsupported minimal reasoning effort", async () => {
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = makeAdapter({ spawner: fake.spawner });
    expect(adapter.capabilities().reasoningEffort).toEqual(["low", "medium", "high", "maximum"]);
    await adapter.run({ ...baseInput, reasoningEffort: "minimal" });
    expect(fake.calls[0]?.args).not.toContain("--effort");
  });

  it("requests Claude JSON output and passes structured output schema", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const fake = fakeSpawn((child) => child.exit(0));
    const adapter = makeAdapter({ spawner: fake.spawner });
    await adapter.run({ ...baseInput, outputSchema: schema });
    const args = fake.calls[0]?.args ?? [];
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).toContain("--json-schema");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "")).toEqual(schema);
  });

  it("uses text stdout as the final message without a schema", async () => {
    const fake = fakeSpawn((child) => {
      child.stdout.write("review ");
      child.stdout.write("done\n");
      child.exit(0);
    });
    const adapter = makeAdapter({ spawner: fake.spawner });
    const result = await adapter.run(baseInput);
    expect(result.lastMessage).toBe("review done");
  });

  it("extracts structured_output from Claude's JSON envelope", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const structured = { summary: "review ok", findings: [] };
    const fake = fakeSpawn((child) => {
      child.stdout.write(JSON.stringify({ type: "result", structured_output: structured }));
      child.exit(0);
    });
    const adapter = makeAdapter({ spawner: fake.spawner });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.lastMessage).toBe(JSON.stringify(structured));
  });

  it("preserves malformed JSON output for generic parsing fallback", async () => {
    const schema = { type: "object" };
    const fake = fakeSpawn((child) => {
      child.stdout.write("{not json");
      child.exit(0);
    });
    const adapter = makeAdapter({ spawner: fake.spawner });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.lastMessage).toBe("{not json");
  });

  it("preserves malformed Claude envelopes without structured_output", async () => {
    const schema = { type: "object" };
    const envelope = { type: "result", result: "plain response" };
    const fake = fakeSpawn((child) => {
      child.stdout.write(JSON.stringify(envelope));
      child.exit(0);
    });
    const adapter = makeAdapter({ spawner: fake.spawner });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.lastMessage).toBe(JSON.stringify(envelope));
  });
});

describe("ClaudeAdapter.detect", () => {
  it("reports available with version", async () => {
    const adapter = makeAdapter({
      probeVersion: () => Promise.resolve("2.1.220 (Claude Code)"),
    });
    expect(await adapter.detect()).toEqual({
      available: true,
      version: "2.1.220 (Claude Code)",
    });
  });

  it("reports unavailable with the reason", async () => {
    const adapter = makeAdapter({
      probeVersion: () => Promise.reject(new Error("ENOENT")),
    });
    const result = await adapter.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("ENOENT");
  });
});
