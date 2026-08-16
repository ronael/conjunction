import { objectiveSection, type Task } from "./task.js";

/**
 * Lot 7 — independent reviewer.
 *
 * The reviewer is a SECOND invocation of the same agent runtime, run read-only
 * against the same worktree, AFTER the final verification passed. It is
 * advisory: findings never change the run's exit code and never feed back
 * into the (deliberately capped) correction loop.
 */

export type ReviewSeverity = "critical" | "major" | "minor" | "nit";

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["critical", "major", "minor", "nit"];

export interface ReviewFinding {
  severity: ReviewSeverity;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
}

/** Per-severity finding counts — single source used by events and formatting. */
export function countFindingsBySeverity(
  findings: readonly ReviewFinding[],
): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { critical: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) {
    counts[finding.severity]++;
  }
  return counts;
}

/**
 * JSON Schema handed to the runtime (codex `--output-schema`) so the reviewer's
 * final message is structured. Runtime-agnostic: the adapter only writes it to
 * a file; runtimes without schema support fall back to raw-text parsing.
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message"],
        properties: {
          severity: { type: "string", enum: [...REVIEW_SEVERITIES] },
          path: { type: "string" },
          message: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
} as const;

const FALLBACK_MESSAGE_MAX_CHARS = 4_000;

/**
 * Parses the reviewer's final message into a ReviewReport. Defensive by
 * design: malformed JSON or a schema mismatch NEVER throws — the raw text
 * becomes a single unstructured finding so the run can still complete.
 */
export function parseReviewReport(raw: string): { report: ReviewReport; structured: boolean } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("review output is not an object");
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.findings)) {
      throw new Error("review output has no findings array");
    }
    const findings: ReviewFinding[] = [];
    for (const entry of record.findings as unknown[]) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
        continue;
      }
      const severity = REVIEW_SEVERITIES.includes(candidate.severity as ReviewSeverity)
        ? (candidate.severity as ReviewSeverity)
        : "minor";
      const finding: ReviewFinding = { severity, message: candidate.message };
      if (typeof candidate.path === "string" && candidate.path.length > 0) {
        finding.path = candidate.path;
      }
      if (typeof candidate.suggestion === "string" && candidate.suggestion.length > 0) {
        finding.suggestion = candidate.suggestion;
      }
      findings.push(finding);
    }
    const summary = typeof record.summary === "string" ? record.summary : "";
    return { report: { summary, findings }, structured: true };
  } catch {
    const text = raw.trim();
    const message =
      text.length > 0
        ? text.slice(0, FALLBACK_MESSAGE_MAX_CHARS)
        : "reviewer returned no parseable output";
    return {
      report: { summary: "", findings: [{ severity: "major", message }] },
      structured: false,
    };
  }
}

/** One-line verification outcome for the reviewer packet. */
export interface ReviewVerificationSummary {
  name: string;
  passed: boolean;
}

/** Bounds so a huge diff can never bloat the reviewer prompt. */
export const REVIEW_DIFF_MAX_LINES = 2_000;
export const REVIEW_DIFF_MAX_CHARS = 100_000;
export const DIFF_TRUNCATION_MARKER = "…(diff truncated)…";

function boundDiff(diff: string): string {
  let out = diff.trimEnd();
  if (out.length === 0) {
    return "(empty diff — the worktree has no changes)";
  }
  const lines = out.split("\n");
  if (lines.length > REVIEW_DIFF_MAX_LINES) {
    out = `${lines.slice(0, REVIEW_DIFF_MAX_LINES).join("\n")}\n${DIFF_TRUNCATION_MARKER}`;
  }
  if (out.length > REVIEW_DIFF_MAX_CHARS) {
    out = `${out.slice(0, REVIEW_DIFF_MAX_CHARS)}\n${DIFF_TRUNCATION_MARKER}`;
  }
  return out;
}

/**
 * Builds the reviewer prompt. Deterministic and pure.
 *
 * Contains: task framing (objective/constraints/acceptance criteria), the
 * bounded worktree diff, and a one-line-per-command verification summary.
 * The implementer's transcript/chain-of-thought is STRUCTURALLY absent —
 * the input type has no field for it (reviewer independence).
 */
export function buildReviewerPacket(input: {
  task: Task;
  diff: string;
  verification: readonly ReviewVerificationSummary[];
}): string {
  const { task, diff, verification } = input;
  const lines: string[] = [
    "You are an independent code reviewer examining a change inside an isolated",
    "git worktree managed by Conjunction. You did NOT write this code.",
    "Review only: do not modify, create, or delete any files.",
    "",
    ...objectiveSection(task),
    "",
    "## Constraints",
    ...(task.constraints.length > 0
      ? task.constraints.map((constraint) => `- ${constraint}`)
      : ["- None specified."]),
    "",
    "## Acceptance criteria",
    ...(task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`)
      : ["- The objective above is fulfilled."]),
    "",
    "## Verification results",
    ...(verification.length > 0
      ? verification.map((result) => `- ${result.passed ? "✓" : "✗"} ${result.name}`)
      : ["- No verification commands were run."]),
    "",
    "## Diff under review (uncommitted changes in the worktree)",
    "```diff",
    boundDiff(diff),
    "```",
    "",
    "## How to respond",
    "- Review the diff against the objective, constraints and acceptance criteria.",
    "- Report only actionable findings, ordered by severity (critical > major >",
    "  minor > nit). If the change is sound, return an empty findings list.",
    "- Give each finding a file path when identifiable and a concrete suggestion.",
  ];
  return lines.join("\n");
}
