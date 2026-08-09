# Reference Projects

These projects are references, not foundations that must be forked.

## 1. ComposioHQ / agent-orchestrator

Repository:
https://github.com/ComposioHQ/agent-orchestrator

Why it matters:

- parallel coding agents;
- one Git worktree / branch / PR per agent;
- runtime/agent/workspace/tracker/SCM plugin boundaries;
- CI failures and review feedback routed back to agents;
- dashboard/operator layer separated from several engine concepts.

What to study:

- plugin interfaces;
- lifecycle/state model;
- workspace abstraction;
- how feedback is routed;
- separation between core and integrations.

What not to copy blindly:

- product-scale complexity;
- large plugin surface before Conjunction has a proven core loop.

## 2. nutthouse / tutti

Repository:
https://github.com/nutthouse/tutti

Why it matters:

- “agent operations as code”;
- roles, workflows, gates and policies;
- runtime can be swapped by role;
- worktree isolation;
- audit trail and repeatable execution pipeline.

What to study:

- declarative configuration;
- workflow/gate concepts;
- role-to-runtime mapping;
- execution ledger.

Potential Conjunction lesson:

Keep the engine imperative internally, but expose a small declarative workflow/policy layer only once the execution primitives are stable.

## 3. jayminwest / overstory

Repository:
https://github.com/jayminwest/overstory

Status:
Archived / no longer actively maintained.

Why it matters:

- strong documentation of the hard parts of multi-agent coding;
- isolated worktrees;
- pluggable agent runtimes;
- SQLite-backed inter-agent mail;
- coordinator / worker / reviewer roles;
- health monitoring and recovery;
- explicit warnings about compounding errors, cost and debugging complexity.

What to study:

- runtime adapter contract;
- typed communication;
- coordinator/worker separation;
- crash recovery;
- watchdog concepts;
- risks described in its documentation.

Potential Conjunction lesson:

Messaging and recovery are important, but should come after the first vertical slice.

## 4. RunMaestro / Maestro

Repository:
https://github.com/RunMaestro/Maestro

Why it matters:

- command-center UX;
- multiple coding-agent providers;
- Git worktree based parallel tasks;
- operator-oriented visualization;
- playbooks / batch tasks.

What to study:

- UX patterns;
- how agent states are presented;
- operator controls;
- how a user understands parallel work without reading raw terminals.

Potential Conjunction lesson:

UI can become a major differentiator later, but it must consume a stable engine/event model rather than define it.

## 5. nwiizo / ccswarm

Repository:
https://github.com/nwiizo/ccswarm

Why it matters:

- smaller orchestration codebase;
- worktree isolation;
- PTY/session management;
- TUI;
- task queue;
- human approval and observability ideas.

Important caution:

The project's own documentation marks several orchestration/provider features as partial, simulated, or not fully wired. Treat it as an implementation-study repository, not proof that every advertised subsystem is production-ready.

## Research questions for Codex

When inspecting these projects, answer:

1. What is the smallest common abstraction for an agent runtime?
2. Which state belongs in core versus an adapter?
3. How do they identify and recover stalled processes?
4. How do they represent tasks and runs?
5. How do they prevent unsafe Git operations?
6. How are worktrees created, cleaned and reconciled?
7. What mechanisms route CI/review feedback?
8. Which abstractions clearly exist only because the project became large?
9. Which features should Conjunction explicitly postpone?
