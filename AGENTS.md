# Conjunction — Repository Agent Instructions

These rules apply to coding agents working in this repository. See
`conjunction-handoff/` for the product vision and `docs/architecture-review.md`
for the current architecture and what is deliberately not built yet.

## Working style

- Inspect before changing.
- Prefer the smallest architecture that proves the requested behavior.
- Do not add frameworks, packages, or abstractions without a concrete use in the
  current lot. Before adding a dependency, answer: which requirement needs it, why
  can't the standard library handle it, does it couple core to a specific agent, and
  will removing it later be expensive?
- Keep runtime-specific (Codex, Claude Code, …) logic out of `src/core/`. Agents are
  adapters behind narrow interfaces.
- Favor deterministic behavior for verification and state transitions.
- Do not implement speculative multi-agent features while the single-agent loop is
  unfinished. No UI, no database.

## Module boundaries

- `src/workspace/` and `src/verification/` are leaf modules: they must not import
  from `src/core/`.
- `src/core/` talks to workspace/verification only through the ports in
  `src/core/orchestrator.ts` (`WorkspaceProvider`, `VerificationRunner`) and the
  `VerificationOutcome` type.
- Tests mirror `src/` under `tests/`.

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

## Documentation

When an architecture decision changes: update the relevant doc, record why, and do
not leave documentation describing a design the code no longer follows. Do not edit
files under `conjunction-handoff/`; record deviations in
`docs/architecture-review.md` instead.
