import type { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AgentAdapter } from "../../src/core/index.js";

export interface ContractProcess {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly killedWith: (NodeJS.Signals | number)[];
  exit(code: number | null): void;
}

export interface ContractCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly detached: boolean;
}

export interface AgentAdapterContractHarness {
  makeSubject(options?: {
    behavior?: (child: ContractProcess, args: readonly string[]) => void;
    killGraceMs?: number;
  }): {
    adapter: AgentAdapter;
    calls: readonly ContractCall[];
    lastProcess(): ContractProcess;
  };
  promptFromCall(call: ContractCall): string | undefined;
  assertReadOnlyTransport(call: ContractCall): void;
}

const BASE_INPUT = {
  target: { runtime: "contract-runtime", model: "contract-model" },
  reasoningEffort: "medium" as const,
  instructions: "CONTRACT INSTRUCTIONS: change only the requested file",
  workspacePath: "/tmp/conjunction-contract-dir",
  timeoutMs: 1_000,
};

export function describeAgentAdapterContract(
  name: string,
  harness: AgentAdapterContractHarness,
): void {
  describe(`${name} AgentAdapter contract`, () => {
    it("declares capabilities explicitly", () => {
      const subject = harness.makeSubject({ behavior: (child) => child.exit(0) });
      const capabilities = subject.adapter.capabilities();
      expect(typeof capabilities.supportsReadOnly).toBe("boolean");
      expect(typeof capabilities.supportsStructuredOutput).toBe("boolean");
      expect(Array.isArray(capabilities.reasoningEffort)).toBe(true);
    });

    it("returns structured process outcome without pass/fail judgment", async () => {
      const subject = harness.makeSubject({ behavior: (child) => child.exit(7) });
      const result = await subject.adapter.run(BASE_INPUT);

      expect(result).toEqual({ exitCode: 7, timedOut: false, aborted: false });
      expect(Object.keys(result).sort()).toEqual(["aborted", "exitCode", "timedOut"]);
      expect("passed" in result).toBe(false);
      expect("success" in result).toBe(false);
    });

    it("streams stdout and stderr without touching events", async () => {
      const subject = harness.makeSubject({
        behavior: (child) => {
          child.stdout.write("out");
          child.stderr.write("err");
          child.exit(0);
        },
      });
      const chunks: [string, string][] = [];

      await subject.adapter.run({
        ...BASE_INPUT,
        onOutput: (chunk, stream) => chunks.push([chunk, stream]),
      });

      expect(chunks).toEqual([
        ["out", "stdout"],
        ["err", "stderr"],
      ]);
    });

    it("honors cancellation through AbortSignal", async () => {
      const subject = harness.makeSubject();
      const controller = new AbortController();
      const promise = subject.adapter.run({ ...BASE_INPUT, signal: controller.signal });

      controller.abort();
      setTimeout(() => subject.lastProcess().exit(null), 20);

      await expect(promise).resolves.toMatchObject({
        exitCode: null,
        timedOut: false,
        aborted: true,
      });
      expect(subject.lastProcess().killedWith.length).toBeGreaterThan(0);
    });

    it("honors timeout and reports it distinctly from cancellation", async () => {
      const subject = harness.makeSubject({ killGraceMs: 10 });
      const promise = subject.adapter.run({ ...BASE_INPUT, timeoutMs: 30 });

      setTimeout(() => subject.lastProcess().exit(null), 60);

      await expect(promise).resolves.toMatchObject({
        exitCode: null,
        timedOut: true,
        aborted: false,
      });
      expect(subject.lastProcess().killedWith.length).toBeGreaterThan(0);
    });

    it("transmits caller-prepared instructions verbatim", async () => {
      const subject = harness.makeSubject({ behavior: (child) => child.exit(0) });
      await subject.adapter.run(BASE_INPUT);

      const call = subject.calls[0];
      expect(call).toBeDefined();
      expect(call === undefined ? undefined : harness.promptFromCall(call)).toBe(
        BASE_INPUT.instructions,
      );
    });

    it("uses read-only mode when requested", async () => {
      const subject = harness.makeSubject({ behavior: (child) => child.exit(0) });
      await subject.adapter.run({ ...BASE_INPUT, readOnly: true });

      const call = subject.calls[0];
      expect(call).toBeDefined();
      if (call !== undefined) {
        harness.assertReadOnlyTransport(call);
      }
    });

    it("has no branch, cleanup, or Git lifecycle knowledge in its transport", async () => {
      const subject = harness.makeSubject({ behavior: (child) => child.exit(0) });
      await subject.adapter.run(BASE_INPUT);

      const call = subject.calls[0];
      expect(call?.cwd).toBe(BASE_INPUT.workspacePath);
      const serialized = [call?.command ?? "", ...(call?.args ?? [])].join(" ");
      expect(serialized).not.toContain("conjunction/");
      expect(serialized).not.toMatch(/\bgit\b/);
      expect(serialized).not.toMatch(/\b(worktree|branch|merge|commit|cleanup)\b/);
    });
  });
}
