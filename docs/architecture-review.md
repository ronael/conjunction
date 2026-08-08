# Architecture Review — Lots 0–3 Bootstrap

Pre-implementation review required by `conjunction-handoff/06-CODEX-FIRST-TASK.md`,
plus a record of where the implementation deviates from `03-ARCHITECTURE.md`.

## Assumptions challenged

- **The proposed `apps/` + `packages/` tree is premature.** `03-ARCHITECTURE.md` itself
  warns against creating packages to satisfy the tree. With no CLI and no second
  consumer, five packages would be ceremony. Decision: single package, internal modules.
- **The `AgentAdapter` sketch should not be finalized yet** — the handoff agrees
  ("do not finalize this interface before inspecting real runtime behavior"). Lots 1–3
  therefore contain zero agent code; see the Lot 4 contract sketch below.
- **`Task.status` is derived state in disguise.** Keeping it is convenient, but it can
  drift from the state of the task's runs. For now the orchestrator updates it on every
  run transition and tests pin that behavior; if multiple runs per task arrive, status
  should become a function of runs, not a stored field.
- **An explicit event stream now is worth it, a message bus is not.** Events are a
  plain in-memory append-only log. No pub/sub, no subscribers — a future UI can poll
  or wrap the store. YAGNI until there is a real consumer.
- **No database, no config file, no CI workflow.** Nothing in Lots 0–3 needs durable
  state, user-facing configuration, or CI to meet its exit criteria; adding them now
  would be speculative. Revisit at Lot 5 (CLI) and first external contributor.

## Single package vs pnpm workspace

Chosen: **one package at the repo root** with internal modules under `src/` and a
strict dependency direction enforced by convention:

- `src/workspace/` and `src/verification/` are **leaf modules** — they import nothing
  from core.
- `src/core/` depends on workspace/verification behavior only through the narrow
  `WorkspaceProvider` / `VerificationRunner` ports and the `VerificationOutcome`
  summary type defined in core. The leaf implementations are structurally assignable
  to these ports (e.g. `VerificationResult` satisfies `VerificationOutcome`), so the
  wiring in Lot 5 needs no adapters or casts.
- Extraction into real packages happens when the CLI (Lot 5) exists as a genuine
  second consumer.

## Lot breakdown (as implemented)

- **Lot 0 — tooling:** package.json (`type: module`, engines node >=20), TypeScript
  strict + `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` /
  `noImplicitOverride`, `module: NodeNext`, target ES2022; vitest; eslint flat config
  (typescript-eslint recommended + eslint-config-prettier); prettier. Canonical
  commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- **Lot 1 — core model:** `Task` (+ normalization/validation), `Run` with an explicit,
  tested state machine (`pending → running → verifying → completed | failed`, plus
  `cancelled` from pending/running; invalid transitions throw
  `InvalidRunStateTransitionError`), an immutable in-memory `EventStore` over a
  discriminated event union, and an `Orchestrator` that drives tasks/runs and appends
  events. No agent invocation anywhere.
- **Lot 2 — workspace:** `execFile`-only git wrapper (no shell, arg arrays, 30s
  timeout), `findRepoRoot`, `createRunWorkspace` (branch `conjunction/<runId>` +
  worktree under `<repoRoot>/.conjunction/worktrees/<runId>`), status/diff, and
  `removeRunWorkspace` with the safety contract below. Tests use real temporary
  repositories in `os.tmpdir()`.
- **Lot 3 — verification:** ordered named commands run sequentially with `execFile`
  (no shell), structured per-command results (exitCode/stdout/stderr/durationMs/
  timedOut), `failFast` (default true), per-command or engine-level timeout
  (default 5 min). Failures are data, never thrown.

## Git-safety contract (workspace module)

- Cleanup **refuses to remove a dirty worktree** unless `force: true` is passed
  (`DirtyWorktreeError` carries the porcelain status).
- Only branches matching `conjunction/<runId>` — derived from a validated run id —
  are ever deleted. The user's current branch is never touched.
- Never merges, never pushes, never `reset --hard`, never checks out anything in the
  user's main working tree.
- Run ids are validated against `^[A-Za-z0-9][A-Za-z0-9_-]*$` and all derived paths
  must resolve under `<repoRoot>/.conjunction/worktrees/` (`UnsafePathError`
  otherwise).
- All git invocations go through `execFile` with argument arrays — no shell, ever.

## Deviations from 03-ARCHITECTURE.md

- Single root package instead of the `apps/` + `packages/` tree (justified above).
- Added a `run.cancelled` event type; the proposed list had no way to observe
  cancellation, which is a state the state machine supports.
- `verification.started` / `verification.passed` carry empty payloads for now; the
  command list lives in the verification layer, and core's port doesn't need it yet.
- No CI workflow (repo has no remote/CI host configured yet).
- `package.json` has no `license` field and is `private: true` — the open-source
  license choice is a human decision pending before first publication.

## Not implemented yet (explicit)

- Agent adapters / any AI or provider invocation (Lot 4).
- CLI (Lot 5), correction feedback loop (Lot 6), independent reviewer (Lot 7).
- Multi-agent orchestration, planner, scheduler, message bus.
- Persistence: runs/events are in-memory only; nothing is written to `.conjunction/`
  except worktrees.
- Configuration file (`conjunction.toml` or similar) — verification commands are
  passed in code for now.
- `.conjunction/` is not auto-added to the host repo's exclude file; in user repos it
  will show as untracked until that is handled (Lot 5 concern).
- UI of any kind.

## Recommended Lot 4 adapter contract (sketch — NOT implemented)

Informed by Lots 1–3: the orchestrator already has the seam (`startRun` → _adapter
goes here_ → `verifyRun`), runs carry `runtime` as a free-form string, and the event
union already defines `agent.started` / `agent.output` / `agent.completed`.

```ts
// Lives in src/core (the port); concrete adapters live outside core, e.g. src/adapters/codex/.

interface AgentAdapter {
  /** Stable runtime id recorded on Run.runtime, e.g. "codex-cli". */
  readonly id: string;
  /** Cheap, side-effect-free check: is the runtime installed/usable? */
  detect(): Promise<AgentAvailability>;
  /**
   * Starts one bounded, non-interactive attempt in the run's worktree.
   * Must not return until the process exits or the timeout/cancellation fires.
   */
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

interface AgentRunInput {
  task: Task; // objective/constraints/acceptanceCriteria as-is
  workspacePath: string; // the worktree from Lot 2 — the adapter's cwd
  timeoutMs: number;
  signal?: AbortSignal; // cancellation feeds Orchestrator.cancelRun
  onOutput?(chunk: string, stream: "stdout" | "stderr"): void; // feeds agent.output events
}

interface AgentRunResult {
  exitCode: number | null; // feeds agent.completed
  timedOut: boolean;
  // No "success" boolean: judging the diff is verification's job (Lot 3),
  // and reviewing it is the reviewer's job (Lot 7) — not the adapter's.
}
```

Rationale:

- **One-shot `run()` instead of `start/send/stop` sessions.** Lot 4 is a single
  bounded attempt; interactive sessions are unproven and every CLI differs. `send()`
  can be added later without breaking `run()` — the reverse is not true.
- **The adapter never decides pass/fail.** Deterministic verification (Lot 3) stays
  the only gate; the adapter just reports process outcome. This keeps "verification
  is not another agent" true.
- **`workspacePath` is the only filesystem contract.** The adapter must not know
  about branches, worktree lifecycle, or cleanup — workspace safety stays in Lot 2.
- **`onOutput` callback over raw stream exposure.** Core appends `agent.output`
  events; adapters never touch the EventStore directly.
- **Start with plain `execFile`/spawn, not a PTY.** Per `05-DECISIONS.md`, PTY only
  when an interactive CLI empirically requires it; the contract above works either
  way.
