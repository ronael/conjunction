import { describe, expect, it } from "vitest";

import { EventStore, type RunStartedEvent, type TaskCreatedEvent } from "../../src/core/index.js";

function taskCreated(taskId: string): TaskCreatedEvent {
  return {
    id: `e-${taskId}`,
    type: "task.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    taskId,
    payload: { title: "t" },
  };
}

function runStarted(taskId: string, runId: string): RunStartedEvent {
  return {
    id: `e-${runId}`,
    type: "run.started",
    timestamp: "2026-01-01T00:00:01.000Z",
    taskId,
    runId,
    payload: { runtime: "stub" },
  };
}

describe("EventStore", () => {
  it("appends and queries events by run and task", () => {
    const store = new EventStore();
    store.append(taskCreated("task-1"));
    store.append(runStarted("task-1", "run-1"));
    store.append(runStarted("task-2", "run-2"));

    expect(store.all()).toHaveLength(3);
    expect(store.forRun("run-1").map((e) => e.type)).toEqual(["run.started"]);
    expect(store.forTask("task-1").map((e) => e.type)).toEqual(["task.created", "run.started"]);
    expect(store.forTask("task-2").map((e) => e.type)).toEqual(["run.started"]);
    expect(store.ofType("run.started")).toHaveLength(2);
  });

  it("freezes events and payloads once appended", () => {
    const store = new EventStore();
    const appended = store.append(runStarted("task-1", "run-1"));
    expect(Object.isFrozen(appended)).toBe(true);
    expect(Object.isFrozen(appended.payload)).toBe(true);
    const [queried] = store.forRun("run-1");
    expect(Object.isFrozen(queried)).toBe(true);
  });

  it("returns copies of the internal list", () => {
    const store = new EventStore();
    store.append(taskCreated("task-1"));
    const snapshot = store.all();
    expect(snapshot).toHaveLength(1);
    store.append(taskCreated("task-2"));
    expect(snapshot).toHaveLength(1);
    expect(store.all()).toHaveLength(2);
  });
});
