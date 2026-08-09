# Conjunction — Start Here

## Purpose

Conjunction is an open-source orchestration runtime for existing coding agents.

The product should **not** try to become another coding model or another Claude Code / Codex clone.
Its value is the layer above those agents:

- normalize and structure the user's intent;
- select and invoke interchangeable coding-agent runtimes;
- isolate work in Git worktrees;
- coordinate roles such as planner, implementer, reviewer, and verifier;
- route failures and review feedback back to the appropriate worker;
- run deterministic verification;
- preserve project context, decisions, and execution history;
- eventually provide a strong operator UI without coupling the engine to that UI.

## Core product principle

> Agents are replaceable. Orchestration, context, policy, verification, and history belong to Conjunction.

## Important constraint for the bootstrap

Do **not** begin by implementing a full multi-agent swarm.

The first vertical slice should prove:

User task
→ Orchestrator
→ AgentAdapter
→ one real runtime
→ isolated workspace/worktree
→ verification
→ result

Only after that loop is solid should parallel workers, planners, reviewers, messaging, and UI be added.

## Read these files in order

1. `01-VISION.md`
2. `02-REFERENCE-PROJECTS.md`
3. `03-ARCHITECTURE.md`
4. `04-MVP-ROADMAP.md`
5. `05-DECISIONS.md`
6. `AGENTS.md`
7. `06-CODEX-FIRST-TASK.md`

## Expected bootstrap behavior

Before coding:

1. Inspect this repository.
2. Read every document above.
3. Compare the proposed architecture with the reference projects.
4. Point out any architecture decision that is premature or risky.
5. Produce a concrete implementation plan split into small lots.
6. Only then implement the bootstrap foundation.

Avoid copying another orchestrator wholesale. We want a small, comprehensible core with explicit boundaries.
