# MVP Roadmap

The objective is not “multi-agent” as fast as possible.
The objective is to build primitives that remain correct when multi-agent arrives.

## Lot 0 — Repository hygiene and architecture

Deliverables:

- TypeScript project/monorepo bootstrap;
- strict compiler settings;
- formatter/linter;
- test runner;
- build pipeline;
- short architecture documentation;
- CI workflow if appropriate;
- clear package boundaries only where justified.

Exit criteria:

- install works;
- typecheck passes;
- lint passes;
- tests pass;
- build passes.

## Lot 1 — Core task/run model

Deliverables:

- Task;
- Run;
- run states;
- event model;
- orchestrator skeleton;
- unit tests for state transitions.

No real AI runtime required yet.

## Lot 2 — Safe workspace primitive

Deliverables:

- detect a Git repository;
- create named branch/worktree for a run;
- inspect diff/status;
- clean up safely;
- prevent destructive or ambiguous operations.

Tests should use temporary Git repositories.

## Lot 3 — Verification engine

Deliverables:

- configurable command list;
- sequential execution;
- structured stdout/stderr/exit status;
- fail-fast vs run-all behavior kept simple;
- verification result attached to the run.

## Lot 4 — First real agent adapter

Start with one runtime only.

Candidate: Codex CLI.

Deliverables:

- availability detection;
- spawn process;
- provide task/context/workspace;
- capture output and exit state;
- basic cancellation/timeout semantics;
- no runtime-specific behavior leaking into core.

The exact Codex invocation must be based on the currently installed CLI/version when implementing.

## Lot 5 — First vertical slice

CLI shape can be minimal, for example:

```bash
conjunction run "add a dark-mode toggle"
conjunction status
```

Flow:

1. normalize/build Task;
2. create isolated workspace;
3. invoke the adapter;
4. collect result;
5. run verification;
6. print useful summary;
7. preserve worktree for human inspection by default.

## Lot 6 — Feedback loop

Only after the first slice works:

- verification failure is transformed into a correction packet;
- same worker can receive one bounded correction attempt;
- record both attempts;
- avoid infinite self-healing loops.

## Lot 7 — Independent reviewer

Add a second role only now:

- reviewer receives objective + constraints + diff + verification result;
- reviewer should not need the implementer's entire transcript;
- reviewer is read-only by default;
- findings are structured.

## Later

- multiple parallel workers;
- planner;
- dynamic runtime selection;
- provider policies;
- GitHub issue/PR integration;
- CI feedback;
- durable SQLite state;
- UI;
- personal context/memory.
