# Proposed Architecture

This is a starting hypothesis, not a frozen design.

## Initial repository shape

```text
conjunction/
├─ apps/
│  └─ cli/
├─ packages/
│  ├─ core/
│  ├─ agents/
│  ├─ adapters/
│  │  └─ codex/
│  ├─ workspace/
│  └─ verification/
├─ docs/
└─ examples/
```

Do not create packages merely to satisfy this tree. If a boundary is not yet real, keep it inside a smaller number of packages and extract later.

## Core domain objects

### Task

A user's desired outcome after normalization.

Suggested conceptual fields:

- id
- title
- objective
- constraints
- acceptance criteria
- relevant paths (optional)
- verification expectations
- status

### Run

One attempt to execute a task.

Conceptually:

- run id
- task id
- runtime / adapter
- workspace
- branch
- timestamps
- state
- events
- final result
- verification result

### AgentAdapter

Conjunction must not know Codex-specific or Claude-specific process details.

A minimal adapter may need capabilities similar to:

```ts
interface AgentAdapter {
  id: string;
  capabilities(): AgentCapabilities;
  start(input: AgentRunInput): Promise<AgentSession>;
  send?(session: AgentSession, message: string): Promise<void>;
  stop(session: AgentSession): Promise<void>;
}
```

Do not finalize this interface before inspecting real runtime behavior.

### Workspace

Responsible for isolated execution context.

Initial target:

- local Git repository;
- branch creation;
- Git worktree creation;
- safe cleanup;
- status/diff inspection.

The workspace layer must not silently merge to the user's main branch.

### Verification

Deterministic project checks should be first-class.

Examples:

- typecheck;
- lint;
- test;
- build;
- custom commands.

Verification output should be structured enough to route failures back to a worker later.

## Event model

Prefer an explicit event stream early, even if initially stored in memory.

Possible events:

- task.created
- run.started
- workspace.created
- agent.started
- agent.output
- agent.completed
- verification.started
- verification.failed
- verification.passed
- run.failed
- run.completed

This gives a future TUI/web/desktop UI something stable to consume.

## Persistence

Do not introduce a database merely because multi-agent systems often use one.

For the bootstrap:

- in-memory execution state is acceptable;
- optionally serialize run metadata/events to `.conjunction/`.

SQLite becomes justified once we need durable queues, resumability, messaging, or concurrent coordination.

## Future architecture, not MVP

```text
                   ┌──────── Planner
Task → Orchestrator├──────── Worker A
                   ├──────── Worker B
                   └──────── Reviewer
                              ↓
                         Verification
                              ↓
                     correction / merge gate
```

Future subsystems may include:

- scheduler;
- typed message bus;
- reviewer packets;
- policy engine;
- cost/token tracking;
- persistent ledger;
- MCP/tool registry;
- personal/project context engine;
- operator UI.
