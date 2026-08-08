import { describe, expect, it } from "vitest";

import { createTask, InvalidTaskInputError } from "../../src/core/index.js";

describe("createTask", () => {
  it("normalizes input: trims strings, defaults lists, sets pending status", () => {
    const task = createTask(
      { title: "  Add dark mode  ", objective: "  Toggle in settings " },
      { createId: () => "task-1" },
    );
    expect(task).toEqual({
      id: "task-1",
      title: "Add dark mode",
      objective: "Toggle in settings",
      constraints: [],
      acceptanceCriteria: [],
      status: "pending",
    });
  });

  it("copies list fields so callers cannot mutate shared arrays", () => {
    const constraints = ["no new deps"];
    const task = createTask(
      { title: "t", objective: "o", constraints, acceptanceCriteria: ["builds"] },
      { createId: () => "task-2" },
    );
    constraints.push("mutated");
    expect(task.constraints).toEqual(["no new deps"]);
    expect(task.acceptanceCriteria).toEqual(["builds"]);
  });

  it("keeps optional fields only when provided", () => {
    const without = createTask({ title: "t", objective: "o" });
    expect("relevantPaths" in without).toBe(false);
    expect("verificationExpectations" in without).toBe(false);

    const withFields = createTask({
      title: "t",
      objective: "o",
      relevantPaths: ["src/"],
      verificationExpectations: ["pnpm test passes"],
    });
    expect(withFields.relevantPaths).toEqual(["src/"]);
    expect(withFields.verificationExpectations).toEqual(["pnpm test passes"]);
  });

  it.each([
    [{ title: "", objective: "o" }, "title"],
    [{ title: "   ", objective: "o" }, "title"],
    [{ title: "t", objective: "" }, "objective"],
  ])("rejects invalid input %o", (input, field) => {
    expect(() => createTask(input)).toThrow(InvalidTaskInputError);
    expect(() => createTask(input)).toThrow(new RegExp(field));
  });

  it("generates an id when none is injected", () => {
    const a = createTask({ title: "t", objective: "o" });
    const b = createTask({ title: "t", objective: "o" });
    expect(a.id).not.toBe(b.id);
  });
});
