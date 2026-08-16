import { objectiveSection, type Task } from "./task.js";

/** One failed verification command, with the output needed to diagnose it. */
export interface FailedCommandReport {
  name: string;
  /** Display form of the command, e.g. "pnpm exec tsc --noEmit". */
  commandLine: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Bounds so a failure dump can never bloat the prompt. */
export const PACKET_TAIL_LINES = 200;
export const PACKET_TAIL_MAX_CHARS = 20_000;

function tail(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) {
    return "(empty)";
  }
  const lines = trimmed.split("\n").slice(-PACKET_TAIL_LINES);
  let out = lines.join("\n");
  if (out.length > PACKET_TAIL_MAX_CHARS) {
    out = `…(truncated)…\n${out.slice(-PACKET_TAIL_MAX_CHARS)}`;
  }
  return out;
}

/**
 * Builds the prompt sent to the SAME worker for its one bounded correction
 * attempt. Deterministic and pure.
 *
 * Deliberately contains: the original task framing, the failed verification
 * commands only (bounded stdout/stderr tails), and the same workspace/git
 * safety rules as the initial prompt. Deliberately excluded: the previous
 * agent transcript / chain-of-thought (reviewer-independence philosophy) and
 * the full output of passing commands (summarized in one line).
 */
export function buildCorrectionPacket(
  task: Task,
  failed: readonly FailedCommandReport[],
  passedNames: readonly string[],
): string {
  const lines: string[] = [
    "You are continuing a task inside the SAME isolated git worktree managed by",
    "Conjunction. Your PREVIOUS attempt in this worktree FAILED verification.",
    "Fix the failures below; do not redo work that already succeeded.",
    "",
    ...objectiveSection(task, "## Original objective"),
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
    `## Verification failures (previous attempt, ${failed.length} command${failed.length === 1 ? "" : "s"})`,
  ];

  for (const report of failed) {
    const outcome = report.timedOut ? "timed out" : `exit ${report.exitCode ?? "null"}`;
    lines.push(
      "",
      `### ${report.name} — \`${report.commandLine}\` (${outcome})`,
      "",
      "stdout (tail):",
      "```",
      tail(report.stdout),
      "```",
      "",
      "stderr (tail):",
      "```",
      tail(report.stderr),
      "```",
    );
  }

  if (passedNames.length > 0) {
    lines.push("", `## Passing checks (do not break these): ${passedNames.join(", ")}`);
  }

  lines.push(
    "",
    "## Workspace rules",
    "- Your working directory is an isolated git worktree on a dedicated branch;",
    "  work only inside this directory.",
    "- Do not run any git commands: no commits, no branch operations, no history",
    "  changes. Leave your changes uncommitted in the working tree.",
    "- Do not read or write files outside this working directory.",
  );

  return lines.join("\n");
}
