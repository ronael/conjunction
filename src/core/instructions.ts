import { objectiveSection, type Task } from "./task.js";

/**
 * Deterministic worker instructions built by Conjunction before the adapter
 * boundary. Adapters transmit this string; they do not interpret Task.
 */
export function buildWorkerInstructions(task: Task): string {
  const lines: string[] = [
    "You are executing a task inside an isolated git worktree managed by Conjunction,",
    "an orchestration runtime for coding agents.",
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
  ];

  if (task.relevantPaths !== undefined && task.relevantPaths.length > 0) {
    lines.push("", "## Relevant paths", ...task.relevantPaths.map((p) => `- ${p}`));
  }
  if (task.verificationExpectations !== undefined && task.verificationExpectations.length > 0) {
    lines.push(
      "",
      "## Verification expectations",
      ...task.verificationExpectations.map((expectation) => `- ${expectation}`),
    );
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
