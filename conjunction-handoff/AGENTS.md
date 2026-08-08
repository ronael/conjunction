# Conjunction Development Instructions

These rules apply to coding agents working on Conjunction.

## Working style

- Inspect before changing.
- Prefer the smallest architecture that proves the requested behavior.
- Do not add frameworks or abstractions without a concrete use in the current lot.
- Keep runtime-specific logic out of core.
- Make Git safety explicit.
- Favor deterministic behavior for verification and state transitions.
- Add tests for core orchestration and workspace behavior.
- Do not silently merge, push, delete branches, or destroy worktrees.
- Do not implement speculative multi-agent features while bootstrapping single-agent execution.

## Quality gates

Before declaring a coding lot complete, run the commands defined by the repository.

At minimum the bootstrap should establish equivalents of:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

If the final toolchain differs, document the canonical equivalents here.

## Architecture discipline

Before adding a dependency or package, answer:

1. Which current requirement needs it?
2. Why can the standard library / existing dependency not handle it?
3. Does this couple core to a specific coding agent?
4. Will removing it later be expensive?

## Git

Development work should normally happen on a feature branch.

For orchestrated runs, prefer isolated Git worktrees.

No destructive Git command should be automated without explicit, testable safeguards.

## Documentation

When an architecture decision changes:

- update the relevant doc;
- record why;
- do not leave documentation describing a design the code no longer follows.
