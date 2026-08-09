# Handoff Notes — 2026-08-08

## Context of the project

The project emerged from a broader workflow problem: repeatedly switching between coding agents and providers, while wanting a stable personal workflow that survives model churn.

The desired system is deliberately one layer above coding agents.

Related but separate concept:
Reqraft can potentially become an upstream task/prompt normalization component in the future.

Possible future flow:

```text
raw user request
  ↓
Reqraft / task normalization
  ↓
Conjunction Task
  ↓
orchestration
  ↓
agents / tools
```

Reqraft should remain a separate project for now.

## Desired development philosophy

- one-shot clarity where possible;
- explicit plan before large changes;
- changes delivered in small lots;
- validation after implementation;
- keep logs/decisions useful for handoff to another agent;
- code quality matters more than impressive demos;
- avoid architecture that only works for one provider.

## Design direction

A sophisticated operator interface is interesting long term.

The eventual UX should make agent activity legible at a glance, for example:

```text
Project
├─ Planner       completed
├─ Worker A      coding
├─ Worker B      waiting
├─ Reviewer      blocked
└─ Verification  3/4 passed
```

However UI experimentation must not dictate the engine architecture during the bootstrap.
