/**
 * Explicit event stream for everything that happens to tasks and runs.
 * A future CLI/TUI consumes these events; they are immutable once appended.
 */

interface EventBase<Type extends string, Payload> {
  readonly id: string;
  readonly type: Type;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  readonly payload: Payload;
}

interface RunScoped {
  readonly taskId: string;
  readonly runId: string;
}

export interface TaskCreatedEvent extends EventBase<"task.created", { title: string }> {
  readonly taskId: string;
}

export interface RunStartedEvent extends EventBase<"run.started", { runtime: string }>, RunScoped {}

export interface WorkspaceCreatedEvent
  extends EventBase<"workspace.created", { workspacePath: string; branch: string }>, RunScoped {}

export interface AgentStartedEvent
  extends EventBase<"agent.started", { runtime: string; invocationId: string }>, RunScoped {}

export interface InvocationEventPayload {
  invocationId: string;
  role: string;
  runtime: string;
  model?: string;
  reasoningEffort: string;
  parentInvocationId?: string;
  readOnly: boolean;
  workspaceWrite: boolean;
  terminationReason?: string;
}

export interface InvocationCreatedEvent
  extends EventBase<"invocation.created", InvocationEventPayload>, RunScoped {}

export interface InvocationStartedEvent
  extends EventBase<"invocation.started", InvocationEventPayload>, RunScoped {}

export interface InvocationCompletedEvent
  extends EventBase<"invocation.completed", InvocationEventPayload>, RunScoped {}

export interface InvocationFailedEvent
  extends EventBase<"invocation.failed", InvocationEventPayload>, RunScoped {}

export interface AgentOutputEvent
  extends
    EventBase<"agent.output", { invocationId: string; stream: "stdout" | "stderr"; chunk: string }>,
    RunScoped {}

export interface AgentCompletedEvent
  extends
    EventBase<"agent.completed", { exitCode: number | null; invocationId: string }>,
    RunScoped {}

export interface DriverDecisionEvent
  extends
    EventBase<
      "driver.decision",
      { decisionId: string; invocationId: string; action: string; reason: string }
    >,
    RunScoped {}

export interface VerificationStartedEvent
  extends EventBase<"verification.started", Record<string, never>>, RunScoped {}

export interface VerificationFailedEvent
  extends EventBase<"verification.failed", { failedCommands: string[] }>, RunScoped {}

export interface VerificationPassedEvent
  extends EventBase<"verification.passed", Record<string, never>>, RunScoped {}

export interface RunFailedEvent extends EventBase<"run.failed", { error: string }>, RunScoped {}

export interface RunCompletedEvent
  extends EventBase<"run.completed", { summary?: string }>, RunScoped {}

export interface RunCancelledEvent
  extends EventBase<"run.cancelled", { reason?: string }>, RunScoped {}

export interface CorrectionStartedEvent
  extends
    EventBase<"correction.started", { attemptIndex: number; failedCommands: string[] }>,
    RunScoped {}

export interface CorrectionCompletedEvent
  extends
    EventBase<"correction.completed", { attemptIndex: number; failedCommands: string[] }>,
    RunScoped {}

/** Finding counts by severity; `errored` marks an advisory reviewer failure. */
export interface ReviewCompletedPayload {
  total: number;
  critical: number;
  major: number;
  minor: number;
  nit: number;
  errored: boolean;
}

export interface ReviewStartedEvent
  extends EventBase<"review.started", Record<string, never>>, RunScoped {}

export interface ReviewCompletedEvent
  extends EventBase<"review.completed", ReviewCompletedPayload>, RunScoped {}

/** Landing record: emitted by the land command after a successful apply. */
export interface RunLandedEvent
  extends
    EventBase<"run.landed", { targetBranch: string; targetCommit: string; patchPath: string }>,
    RunScoped {}

export type ConjunctionEvent =
  | TaskCreatedEvent
  | RunStartedEvent
  | WorkspaceCreatedEvent
  | InvocationCreatedEvent
  | InvocationStartedEvent
  | InvocationCompletedEvent
  | InvocationFailedEvent
  | AgentStartedEvent
  | AgentOutputEvent
  | AgentCompletedEvent
  | DriverDecisionEvent
  | VerificationStartedEvent
  | VerificationFailedEvent
  | VerificationPassedEvent
  | RunFailedEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | CorrectionStartedEvent
  | CorrectionCompletedEvent
  | ReviewStartedEvent
  | ReviewCompletedEvent
  | RunLandedEvent;

export type ConjunctionEventType = ConjunctionEvent["type"];

/**
 * In-memory append-only event log.
 * Events are frozen on append; queries return shallow copies of the list,
 * never the internal array.
 */
export class EventStore {
  #events: ConjunctionEvent[] = [];

  append<T extends ConjunctionEvent>(event: T): Readonly<T> {
    Object.freeze(event.payload);
    Object.freeze(event);
    this.#events.push(event);
    return event;
  }

  all(): readonly ConjunctionEvent[] {
    return [...this.#events];
  }

  forRun(runId: string): readonly ConjunctionEvent[] {
    return this.#events.filter((event) => "runId" in event && event.runId === runId);
  }

  forTask(taskId: string): readonly ConjunctionEvent[] {
    return this.#events.filter((event) => event.taskId === taskId);
  }

  ofType<T extends ConjunctionEventType>(
    type: T,
  ): readonly Extract<ConjunctionEvent, { type: T }>[] {
    return this.#events.filter(
      (event): event is Extract<ConjunctionEvent, { type: T }> => event.type === type,
    );
  }
}
