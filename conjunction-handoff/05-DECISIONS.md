# Current Decisions and Open Questions

## Decisions already made

### Build a new repository rather than fork a reference project

Reason:
Conjunction should learn from existing orchestrators without inheriting their full architecture and accidental complexity.

### Runtime-agnostic by design

Codex, Claude Code, OpenCode, Kimi, Cursor and future runtimes should be adapters rather than the core product.

### Worktree isolation is a core primitive

Parallel or autonomous code modification should not happen in the user's primary working tree.

### Verification is not “another agent”

Typecheck, lint, tests and build are deterministic gates and should remain deterministic where possible.

### Reviewer should be independent

The implementer should not be the sole authority judging its own code.

A reviewer should ideally receive:

- task objective;
- constraints;
- acceptance criteria;
- diff;
- verification output.

It should not automatically receive all implementation chain-of-thought/session chatter.

### Start single-agent

Do not build the swarm first.

### UI later, event model now

A future interface is desirable, potentially significantly more ambitious than a classic terminal or desktop shell, but the core must expose stable state/events first.

## Open questions

### Language / runtime

Initial bias: TypeScript, because:

- ecosystem fit with current project preferences;
- easy CLI/process/Git tooling;
- fast iteration.

But Codex should challenge this if another choice materially improves process control, portability or distribution.

### Monorepo vs one package

A monorepo is a hypothesis.
Do not split into many packages if the initial codebase does not justify them.

### PTY vs child process

Needs empirical investigation per coding-agent CLI.

Start with the simplest reliable process model.
Introduce PTY only when interactive semantics require it.

### Persistence

Start without a database.
Consider `.conjunction/` structured files.
Move to SQLite when durable concurrent state is genuinely needed.

### Configuration

Eventually something like `conjunction.toml`, YAML, or JSON may describe:

- roles;
- runtime mappings;
- verification commands;
- policies.

Do not design the complete schema during bootstrap.

### Context engine

Long term, Conjunction may combine:

- repository instructions;
- AGENTS.md;
- architecture docs;
- personal rules/preferences;
- task-specific context;
- historical decisions.

This is an important differentiator, but not required to prove the execution engine.
