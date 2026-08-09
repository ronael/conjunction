import { describe, expect, it } from "vitest";

import { runVerification } from "../../src/verification/index.js";

const CWD = process.cwd();
const node = process.execPath;

const ok = { name: "ok", command: node, args: ["-e", "process.exit(0)"] };
const fail = { name: "fail", command: node, args: ["-e", "process.exit(1)"] };

describe("runVerification", () => {
  it("passes when all commands exit 0", async () => {
    const result = await runVerification([ok, { ...ok, name: "ok-2" }], { cwd: CWD });
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      name: "ok",
      exitCode: 0,
      timedOut: false,
    });
    expect(result.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails when a command exits non-zero, and captures the exit code", async () => {
    const result = await runVerification([fail], { cwd: CWD });
    expect(result.passed).toBe(false);
    expect(result.results[0]?.exitCode).toBe(1);
  });

  it("captures stdout and stderr verbatim", async () => {
    const result = await runVerification(
      [
        {
          name: "noisy",
          command: node,
          args: ["-e", "process.stdout.write('out');process.stderr.write('err')"],
        },
      ],
      { cwd: CWD },
    );
    expect(result.results[0]?.stdout).toBe("out");
    expect(result.results[0]?.stderr).toBe("err");
  });

  it("fail-fast (default) stops after the first failure", async () => {
    const result = await runVerification([fail, ok], { cwd: CWD });
    expect(result.passed).toBe(false);
    expect(result.results.map((r) => r.name)).toEqual(["fail"]);
  });

  it("failFast: false runs all commands and aggregates", async () => {
    const result = await runVerification([fail, ok, { ...fail, name: "fail-2" }], {
      cwd: CWD,
      failFast: false,
    });
    expect(result.passed).toBe(false);
    expect(result.results.map((r) => r.name)).toEqual(["fail", "ok", "fail-2"]);
  });

  it("times out long-running commands and marks them timedOut", async () => {
    const result = await runVerification(
      [
        {
          name: "slow",
          command: node,
          args: ["-e", "setTimeout(() => {}, 60_000)"],
          timeoutMs: 200,
        },
      ],
      { cwd: CWD },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.timedOut).toBe(true);
    expect(result.results[0]?.exitCode).toBeNull();
    expect(result.results[0]?.durationMs).toBeLessThan(10_000);
  });

  it("honors a per-command timeout over the engine default", async () => {
    const result = await runVerification(
      [{ name: "slow", command: node, args: ["-e", "setTimeout(() => {}, 60_000)"] }],
      { cwd: CWD, timeoutMs: 200 },
    );
    expect(result.results[0]?.timedOut).toBe(true);
  });

  it("reports an unspawnable command as failed, not as a throw", async () => {
    const result = await runVerification(
      [{ name: "missing", command: "conjunction-no-such-binary-xyz" }],
      { cwd: CWD },
    );
    expect(result.passed).toBe(false);
    expect(result.results[0]?.exitCode).toBeNull();
    expect(result.results[0]?.timedOut).toBe(false);
  });

  it("an empty command list passes trivially", async () => {
    const result = await runVerification([], { cwd: CWD });
    expect(result.passed).toBe(true);
    expect(result.results).toEqual([]);
  });

  it("fires onCommandStart/onCommandEnd around each executed command", async () => {
    const calls: string[] = [];
    const result = await runVerification([ok, fail, { ...ok, name: "never-runs" }], {
      cwd: CWD,
      onCommandStart: (command) => calls.push(`start:${command.name}`),
      onCommandEnd: (command, commandResult) =>
        calls.push(`end:${command.name}:${commandResult.exitCode ?? "null"}`),
    });
    expect(result.passed).toBe(false);
    // fail-fast: the third command never starts
    expect(calls).toEqual(["start:ok", "end:ok:0", "start:fail", "end:fail:1"]);
  });

  it("abort kills the running command promptly and stops the loop", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const startedAt = Date.now();
    const promise = runVerification(
      [
        { name: "slow", command: node, args: ["-e", "setTimeout(() => {}, 60_000)"] },
        { ...ok, name: "never-runs" },
      ],
      {
        cwd: CWD,
        failFast: false,
        signal: controller.signal,
        onCommandStart: (command) => calls.push(`start:${command.name}`),
      },
    );
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.exitCode).toBeNull();
    expect(result.results[0]?.timedOut).toBe(false); // aborted, not timed out
    // the loop stopped: the second command never started
    expect(calls).toEqual(["start:slow"]);
  });
});
