import { describe, expect, it } from "vitest";

import {
  buildReviewerPacket,
  DIFF_TRUNCATION_MARKER,
  parseReviewReport,
  REVIEW_DIFF_MAX_LINES,
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

const DIFF = "diff --git a/src/settings.ts b/src/settings.ts\n+  const dark = true;";

describe("buildReviewerPacket", () => {
  it("frames the reviewer as independent and read-only, with the task context", () => {
    const packet = buildReviewerPacket({
      task: makeTask(),
      diff: DIFF,
      verification: [{ name: "typecheck", passed: true }],
    });
    expect(packet).toContain("independent code reviewer");
    expect(packet).toContain("You did NOT write this code");
    expect(packet).toContain("do not modify, create, or delete any files");
    expect(packet).toContain("Add a dark-mode toggle to settings");
    expect(packet).toContain("- no new dependencies");
    expect(packet).toContain("- toggle persists across reloads");
  });

  it("includes the bounded diff and one line per verification command", () => {
    const packet = buildReviewerPacket({
      task: makeTask(),
      diff: DIFF,
      verification: [
        { name: "typecheck", passed: true },
        { name: "test", passed: false },
      ],
    });
    expect(packet).toContain("```diff");
    expect(packet).toContain("+  const dark = true;");
    expect(packet).toContain("- ✓ typecheck");
    expect(packet).toContain("- ✗ test");
  });

  it("notes when no verification ran and when the diff is empty", () => {
    const packet = buildReviewerPacket({ task: makeTask(), diff: "  \n", verification: [] });
    expect(packet).toContain("- No verification commands were run.");
    expect(packet).toContain("(empty diff — the worktree has no changes)");
  });

  it("truncates an oversized diff with a marker", () => {
    const huge = Array.from({ length: REVIEW_DIFF_MAX_LINES + 500 }, (_, i) => `+line-${i}`).join(
      "\n",
    );
    const packet = buildReviewerPacket({ task: makeTask(), diff: huge, verification: [] });
    expect(packet).toContain(DIFF_TRUNCATION_MARKER);
    expect(packet).toContain("+line-0");
    expect(packet).not.toContain(`+line-${REVIEW_DIFF_MAX_LINES}`);
  });

  it("carries no transcript — input surface has none, output has only review sections", () => {
    const packet = buildReviewerPacket({
      task: makeTask(),
      diff: DIFF,
      verification: [{ name: "typecheck", passed: true }],
    });
    const sections = packet.split("\n").filter((line) => line.startsWith("## "));
    expect(sections).toEqual([
      "## Objective",
      "## Constraints",
      "## Acceptance criteria",
      "## Verification results",
      "## Diff under review (uncommitted changes in the worktree)",
      "## How to respond",
    ]);
  });
});

describe("parseReviewReport", () => {
  it("parses a valid structured report", () => {
    const raw = JSON.stringify({
      summary: "solid change, one issue",
      findings: [
        {
          severity: "major",
          path: "src/settings.ts",
          message: "no persistence",
          suggestion: "store it",
        },
        { severity: "nit", message: "naming" },
        { severity: "bogus-severity", message: "defaults to minor" },
      ],
    });
    const { report, structured } = parseReviewReport(raw);
    expect(structured).toBe(true);
    expect(report.summary).toBe("solid change, one issue");
    expect(report.findings).toEqual([
      {
        severity: "major",
        path: "src/settings.ts",
        message: "no persistence",
        suggestion: "store it",
      },
      { severity: "nit", message: "naming" },
      { severity: "minor", message: "defaults to minor" },
    ]);
  });

  it("skips malformed finding entries instead of failing", () => {
    const raw = JSON.stringify({
      summary: "",
      findings: [{ noMessage: true }, "junk", { severity: "nit", message: "ok" }],
    });
    const { report, structured } = parseReviewReport(raw);
    expect(structured).toBe(true);
    expect(report.findings).toEqual([{ severity: "nit", message: "ok" }]);
  });

  it("falls back to a single unstructured finding on malformed JSON", () => {
    const { report, structured } = parseReviewReport("this is not json at all");
    expect(structured).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe("major");
    expect(report.findings[0]?.message).toBe("this is not json at all");
  });

  it("falls back on schema mismatch (valid JSON, wrong shape)", () => {
    const { report, structured } = parseReviewReport(JSON.stringify({ nope: [] }));
    expect(structured).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.message).toContain("nope");
  });

  it("handles empty output without crashing", () => {
    const { report, structured } = parseReviewReport("");
    expect(structured).toBe(false);
    expect(report.findings[0]?.message).toBe("reviewer returned no parseable output");
  });
});
