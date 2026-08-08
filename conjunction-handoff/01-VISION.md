# Conjunction — Product Vision

## Problem

Coding agents such as Codex, Claude Code, OpenCode, Cursor, Kimi Code and others are increasingly capable, but using several of them creates a new problem:

- each has its own session model and CLI;
- context is duplicated or lost;
- parallel work collides;
- humans manually create branches/worktrees;
- CI failures need to be copied back to agents;
- review comments need to be routed manually;
- the same agent that wrote code is often trusted to validate itself;
- model choice becomes coupled to the workflow;
- project conventions are repeatedly re-explained.

Conjunction should solve the **coordination problem**, not the code-generation problem.

## Long-term direction

Conjunction can eventually become a personal developer runtime:

```text
Human
  ↓
Task normalization / context
  ↓
Lead / Orchestrator
  ├─ Planner
  ├─ Implementer(s)
  ├─ Reviewer
  └─ Verifier
  ↓
Git / CI / project tools
  ↓
Deliverable
```

The runtime should know:

- project rules;
- architectural decisions;
- validation commands;
- allowed tools;
- preferred agent/runtime by role;
- prior execution outcomes;
- potentially personal development preferences.

This context must remain useful even when models change.

## Non-goals for the initial versions

- Training or hosting our own coding model.
- Recreating a full IDE.
- Building a distributed swarm before a single-agent execution loop works.
- Starting with a complex graph framework just because it is fashionable.
- Hiding all Git behavior behind opaque automation.
- Giving every agent unrestricted write access.
- Making a web/desktop UI the architectural center of the product.

## Product qualities

Conjunction should feel:

- inspectable;
- local-first where practical;
- provider/runtime agnostic;
- deterministic around verification;
- safe around Git;
- resumable;
- observable;
- easy to debug;
- useful with one agent before becoming useful with ten.
