import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKFLOW,
  getWorkflow,
  isWorkflowName,
  type Role,
  WORKFLOW_NAMES,
  WORKFLOWS,
  workflowIncludes,
} from "../../src/core/workflow.js";

const coreDir = path.join(fileURLToPath(new URL("../../src/core/", import.meta.url)));

describe("workflows", () => {
  it("every registered name resolves to a definition that agrees with its key", () => {
    for (const name of WORKFLOW_NAMES) {
      expect(getWorkflow(name).name).toBe(name);
      expect(getWorkflow(name).roles.length).toBeGreaterThan(0);
    }
    expect(Object.keys(WORKFLOWS).sort()).toEqual([...WORKFLOW_NAMES].sort());
  });

  it("the default workflow reproduces the pre-workflow behavior (worker, no critic)", () => {
    expect(DEFAULT_WORKFLOW).toBe("single");
    expect(workflowIncludes("single", "worker")).toBe(true);
    expect(workflowIncludes("single", "critic")).toBe(false);
  });

  it("review adds the independent critic on top of the worker", () => {
    expect(workflowIncludes("review", "worker")).toBe(true);
    expect(workflowIncludes("review", "critic")).toBe(true);
  });

  it("canonically names the future lead/supervisor role as driver without scheduling it yet", () => {
    const driver: Role = "driver";
    expect(driver).toBe("driver");
    for (const name of WORKFLOW_NAMES) {
      expect(workflowIncludes(name, "driver")).toBe(false);
    }
  });

  it("every workflow includes a worker — nothing runs without one", () => {
    for (const name of WORKFLOW_NAMES) {
      expect(workflowIncludes(name, "worker")).toBe(true);
    }
  });

  it("isWorkflowName narrows only known names", () => {
    expect(isWorkflowName("single")).toBe(true);
    expect(isWorkflowName("review")).toBe(true);
    expect(isWorkflowName("quality")).toBe(false); // designed, not implemented
    expect(isWorkflowName("")).toBe(false);
  });
});

describe("architecture boundaries", () => {
  async function coreSources(): Promise<{ file: string; source: string }[]> {
    const files = (await readdir(coreDir)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5); // guard against silently reading nothing
    return Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(path.join(coreDir, file), "utf8"),
      })),
    );
  }

  it("core imports no concrete adapter, runtime SDK or UI library", async () => {
    // Comments may name a runtime as an EXAMPLE (e.g. `Run.runtime` = "codex-cli");
    // what must never exist is a dependency on one.
    const forbiddenImport =
      /\bfrom\s+"(\.\.\/adapters\/|ink|react|@anthropic-ai\/|openai|@openai\/)/;
    for (const { file, source } of await coreSources()) {
      expect(forbiddenImport.test(source), `${file} must not import a runtime or a UI`).toBe(false);
    }
  });

  it("core does no filesystem, process or network I/O", async () => {
    const forbiddenImport = /\bfrom\s+"node:(fs|fs\/promises|child_process|http|https|net)"/;
    for (const { file, source } of await coreSources()) {
      expect(forbiddenImport.test(source), `${file} must stay pure (no I/O)`).toBe(false);
    }
  });

  it("the role vocabulary itself names no provider at all", async () => {
    const source = await readFile(path.join(coreDir, "workflow.ts"), "utf8");
    for (const pattern of [/codex/i, /claude/i, /openai/i, /anthropic/i, /gpt-/i]) {
      expect(pattern.test(source), `workflow.ts must describe roles, not ${String(pattern)}`).toBe(
        false,
      );
    }
  });
});
