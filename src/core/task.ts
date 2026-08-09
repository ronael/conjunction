import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/**
 * A user's desired outcome after normalization.
 * Tasks are inputs to runs; a task may be attempted by several runs over time.
 */
export interface Task {
  readonly id: string;
  title: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  relevantPaths?: string[];
  verificationExpectations?: string[];
  status: TaskStatus;
}

export interface TaskInput {
  title: string;
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  relevantPaths?: string[];
  verificationExpectations?: string[];
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
  return task;
}
