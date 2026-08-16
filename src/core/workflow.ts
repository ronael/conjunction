/**
 * Workflows and roles — the runtime-agnostic vocabulary for "which participants
 * take part in a run".
 *
 * A workflow is a NAME for a combination of capabilities that already exist
 * (worker, deterministic verification, independent critic); it introduces no
 * new behavior. Core owns the vocabulary only — the phase sequence itself lives
 * in the composition layer (see docs/brief-workflow-design.md §5.4).
 *
 * Deliberately absent:
 * - a "lead" role: no producer emits it yet (adding it later is one word);
 * - RoleAssignment (role → runtime → model): with one adapter it would be a
 *   mapping with a single possible value;
 * - any DSL / config format: there is nothing yet to configure.
 */

/**
 * What a participant is FOR — never how it is executed (runtime) or which AI
 * backs it (model). No adapter or provider name may ever appear here.
 */
export type Role = "worker" | "critic";

export type WorkflowName = "single" | "review";

export interface WorkflowDefinition {
  readonly name: WorkflowName;
  /** Participants, in the order they act. */
  readonly roles: readonly Role[];
  readonly description: string;
}

/**
 * The complete workflow table. Hard-coded on purpose: a configuration format
 * earns its place when workflows carry per-role runtime/model assignments.
 *
 * Note that the bounded correction attempt is part of EVERY workflow — it is
 * the same worker responding to deterministic feedback, not a separate role.
 * `--no-correct` tightens that bound to zero, orthogonally to the workflow.
 */
export const WORKFLOWS: Readonly<Record<WorkflowName, WorkflowDefinition>> = {
  single: {
    name: "single",
    roles: ["worker"],
    description: "worker → verification (with the bounded correction attempt)",
  },
  review: {
    name: "review",
    roles: ["worker", "critic"],
    description: "worker → verification → independent read-only critic",
  },
};

export const WORKFLOW_NAMES: readonly WorkflowName[] = ["single", "review"];

/** Reproduces the pre-workflow default: worker + verification + correction. */
export const DEFAULT_WORKFLOW: WorkflowName = "single";

export function isWorkflowName(value: string): value is WorkflowName {
  return (WORKFLOW_NAMES as readonly string[]).includes(value);
}

export function getWorkflow(name: WorkflowName): WorkflowDefinition {
  return WORKFLOWS[name];
}

/** Whether the given role takes part in the workflow. */
export function workflowIncludes(name: WorkflowName, role: Role): boolean {
  return WORKFLOWS[name].roles.includes(role);
}
