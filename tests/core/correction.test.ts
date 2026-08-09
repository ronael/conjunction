import { describe, expect, it } from "vitest";

import {
  buildCorrectionPacket,
  PACKET_TAIL_LINES,
  type FailedCommandReport,
  type Task,
} from "../../src/core/index.js";

function makeTask(): Task {
  return {
    id: "task-1",
    title: "add dark mode",
    objective: "Add a dark-mode toggle to settings",
    constraints: ["no new dependencies"],
    acceptanceCriteria: ["toggle persists across reloads"],
    status: "in_progress",
  };
}

const failedCmd: FailedCommandReport = {
  name: "test",
  commandLine: "pnpm test",
  exitCode: 1,
  timedOut: false,
  stdout: "2 tests passed",
  stderr: "FAIL settings.test.ts\nexpected dark mode to persist",
};

describe("buildCorrectionPacket", () => {
  it("frames the correction and includes the original task", () => {
    const packet = buildCorrectionPacket(makeTask(), [failedCmd], ["typecheck"]);
    expect(packet).toContain("PREVIOUS attempt in this worktree FAILED verification");
    expect(packet).toContain("do not redo work that already succeeded");
    expect(packet).toContain("Add a dark-mode toggle to settings");
    expect(packet).toContain("- no new dependencies");
    expect(packet).toContain("- toggle persists across reloads");
  });

  it("includes only the failed commands with exit state and output tails", () => {
    const packet = buildCorrectionPacket(makeTask(), [failedCmd], ["typecheck", "lint"]);
    expect(packet).toContain("### test — `pnpm test` (exit 1)");
    expect(packet).toContain("FAIL settings.test.ts");
    expect(packet).toContain("expected dark mode to persist");
    // passing commands appear only as a one-line summary, never a section
    expect(packet).toContain("Passing checks (do not break these): typecheck, lint");
    expect(packet).not.toContain("### typecheck");
  });

  it("marks timeouts distinctly", () => {
    const packet = buildCorrectionPacket(
      makeTask(),
      [{ ...failedCmd, timedOut: true, exitCode: null }],
      [],
    );
    expect(packet).toContain("(timed out)");
  });

  it("bounds stdout/stderr tails to the last N lines", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const packet = buildCorrectionPacket(makeTask(), [{ ...failedCmd, stderr: huge }], []);
    expect(packet).toContain(`line-${499}`);
    expect(packet).toContain(`line-${499 - PACKET_TAIL_LINES + 1}`);
    expect(packet).not.toContain(`line-${499 - PACKET_TAIL_LINES}`);
  });

  it("contains the same git-safety rules as the initial prompt", () => {
    const packet = buildCorrectionPacket(makeTask(), [failedCmd], []);
    expect(packet).toContain("isolated git worktree");
    expect(packet).toContain("Do not run any git commands");
  });

  it("carries no transcript — only task, failures and rules", () => {
    // The builder's input surface has no transcript field at all; assert the
    // output shape is exactly the intended sections.
    const packet = buildCorrectionPacket(makeTask(), [failedCmd], ["typecheck"]);
    const sections = packet.split("\n").filter((line) => line.startsWith("## "));
    expect(sections).toEqual([
      "## Original objective",
      "## Constraints",
      "## Acceptance criteria",
      "## Verification failures (previous attempt, 1 command)",
      "## Passing checks (do not break these): typecheck",
      "## Workspace rules",
    ]);
  });
});
