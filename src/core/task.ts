import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/**
 * Where the objective text came from. Provenance only — the full text always
 * lives in `Task.objective`, so a persisted run stays self-contained even if
 * the brief file is later edited or deleted.
 */
export type TaskSource = { kind: "inline" } | { kind: "file"; path: string };

/**
 * A user's desired outcome after normalization.
 * Tasks are inputs to runs; a task may be attempted by several runs over time.
 */
export interface Task {
  readonly id: string;
  title: string;
  /** The brief, verbatim. Never parsed, never truncated. */
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  relevantPaths?: string[];
  verificationExpectations?: string[];
  /** Absent on runs recorded before brief support; treat as `{ kind: "inline" }`. */
  source?: TaskSource;
  status: TaskStatus;
}

export interface TaskInput {
  title: string;
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  relevantPaths?: string[];
  verificationExpectations?: string[];
  source?: TaskSource;
}

export class InvalidTaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskInputError";
  }
}

export interface TaskFactoryDeps {
  createId?: () => string;
}

/**
 * Normalizes raw input into a Task: trims required strings, copies list fields
 * so callers cannot mutate shared arrays, and defaults the status to "pending".
 */
export function createTask(input: TaskInput, deps: TaskFactoryDeps = {}): Task {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (title.length === 0) {
    throw new InvalidTaskInputError("task title must not be empty");
  }
  if (objective.length === 0) {
    throw new InvalidTaskInputError("task objective must not be empty");
  }

  const task: Task = {
    id: (deps.createId ?? randomUUID)(),
    title,
    objective,
    constraints: [...(input.constraints ?? [])],
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    status: "pending",
  };
  if (input.relevantPaths !== undefined) {
    task.relevantPaths = [...input.relevantPaths];
  }
  if (input.verificationExpectations !== undefined) {
    task.verificationExpectations = [...input.verificationExpectations];
  }
  if (input.source !== undefined) {
    task.source = input.source;
  }
  return task;
}

/**
 * The heading + body under which a task's objective is rendered into an agent
 * packet. Single-sourced so the initial prompt, the correction packet and the
 * reviewer packet frame the brief identically.
 *
 * A file-sourced objective is a whole document (usually with its own `#`/`##`
 * headings), so it is announced as "## Brief" rather than nested under
 * "## Objective". The content itself is always inserted verbatim.
 */
export function objectiveSection(task: Task, inlineHeading = "## Objective"): string[] {
  if (task.source?.kind === "file") {
    return [`## Brief (${task.source.path})`, task.objective];
  }
  return [inlineHeading, task.objective];
}
