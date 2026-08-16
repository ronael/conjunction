# Conjunction — Repository Agent Instructions

These rules apply to coding agents working in this repository. See
`conjunction-handoff/` for the product vision, `docs/architecture-review.md`
for the current architecture and what is deliberately not built yet, and
`docs/brief-workflow-design.md` for the brief/workflow/role model and the
proposed (unimplemented) Supervisor v0.

## Working style

- Inspect before changing.
- Prefer the smallest architecture that proves the requested behavior.
- Do not add frameworks, packages, or abstractions without a concrete use in the
  current lot. Before adding a dependency, answer: which requirement needs it, why
  can't the standard library handle it, does it couple core to a specific agent, and
  will removing it later be expensive?
- Keep runtime-specific (Codex, Claude Code, …) logic out of `src/core/`. Agents are
  adapters behind narrow interfaces. Core names **roles** (`worker`, `critic`, …),
  never providers; never confuse Role (what it is for), Runtime (how it is executed)
  and Model (which AI). No `CodexWorker`/`ClaudeReviewer` types, ever.
- The brief is the run's source of truth and is kept verbatim in `task.objective`.
  Do not add a markdown parser that extracts headings into `Task` fields — see
  `docs/brief-workflow-design.md` §4.1 for the reasoning and the trigger to revisit.
- Favor deterministic behavior for verification and state transitions.
- Do not implement speculative multi-agent features while the single-agent loop is
  unfinished. No database.

## Module boundaries

- `src/workspace/` and `src/verification/` are leaf modules: they must not import
  from `src/core/`.
- `src/core/` talks to workspace/verification only through the ports in
  `src/core/orchestrator.ts` (`WorkspaceProvider`, `VerificationRunner`) and the
  `VerificationOutcome` type. Agent runtimes plug in through the `AgentAdapter`
  port in `src/core/agent.ts`; core never imports a concrete adapter.
- `src/adapters/<runtime>/` (e.g. `codex/`) are leaf modules that implement
  `AgentAdapter`. They may import core types; only `src/cli/` wires them in.
  Adapters report process outcome only — never pass/fail judgments.
- `src/cli/` is the composition root: it wires core + workspace + verification +
  the adapter, resolves user input (briefs, `--verify`, `--repo`), owns the run
  phase sequence (`run-command.ts`) and run persistence (run JSON plus JSONL
  events under `.conjunction/runs/`). Core stays I/O-free —
  `tests/core/workflow.test.ts` enforces it.
- `src/cli/ui/` (the TUI) is a leaf consumer: it reads run/task objects and the
  `RunObserver` seams only. The engine must never know it exists; keep it
  loadable via dynamic import so plain/CI mode never pulls in ink/react.
- Tests mirror `src/` under `tests/`. Unit tests for adapters must fake the
  process spawner — never invoke a real agent runtime in vitest.

## Git safety

- Development happens on a feature branch.
- Orchestrated runs use isolated worktrees under `.conjunction/worktrees/`; only the
  workspace module may create or remove them.
- Never automate merges, pushes, branch deletion outside the `conjunction/` prefix,
  or `reset --hard`. Cleanup of a dirty worktree requires explicit `force: true`.
- No destructive Git command without explicit, testable safeguards.

## Canonical validation commands

Run all of these before declaring a lot complete:

```bash
pnpm install      # after dependency changes
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint . && prettier --check .
pnpm test         # vitest run
pnpm build        # tsc -p tsconfig.build.json
```

`pnpm format` fixes formatting/lint autofixes.

## CLI

The `conjunction` bin builds to `dist/cli/main.js` (`node dist/cli/main.js --help`;
see `docs/usage.md`). When changing CLI flags or behavior, keep `docs/usage.md`
in sync.

## Documentation

When an architecture decision changes: update the relevant doc, record why, and do
not leave documentation describing a design the code no longer follows. Do not edit
files under `conjunction-handoff/`; record deviations in
`docs/architecture-review.md` instead.
