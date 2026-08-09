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

- Correction feedback loop (Lot 6), independent reviewer (Lot 7).
- Multi-agent orchestration, planner, scheduler, message bus.
- Additional agent adapters (claude-code, opencode, …); only codex exists.
- Configuration file (`conjunction.toml` or similar) — verification commands are
  CLI flags for now.
- `.conjunction/` is not auto-added to the host repo's exclude file; in user repos it
  will show as untracked until that is handled.
- Durable/resumable state: run metadata is persisted as JSON/JSONL, but an
  interrupted CLI process cannot resume a run.
- UI of any kind.

## Lot 4/5 as implemented (supersedes the sketch below)

The Lot 4 contract landed as sketched, with three refinements reality required:

- `AgentRunResult.aborted: boolean` — distinguishes AbortSignal cancellation
  (→ `run.cancelled`) from timeout (→ `run.failed`) and process failure.
- `AgentRunResult.lastMessage?: string` — codex exposes the final agent message via
  `-o/--output-last-message`; the orchestrator stores it as `run.result.summary`.
- `Orchestrator.executeRun(runId, { timeoutMs, signal?, onOutput? })` — the seam the
  sketch predicted (`startRun` → adapter → `verifyRun`). Outcome mapping: exit 0 keeps
  the run `running` (verification decides); non-zero/null exit or timeout fails it;
  abort cancels it. Emits `agent.started` / `agent.output` / `agent.completed`.

The codex adapter (`src/adapters/codex/`, leaf module — core never imports it) invokes:

```
codex exec -C <worktree> -s workspace-write --ephemeral --color never \
  -o <tmpfile> [-m <model>] -- <prompt>
```

- Sandbox is hardcoded to `workspace-write` (not a constructor option); the dangerous
  modes are never emitted.
- The process spawner is an injected seam (`ProcessSpawner`); unit tests fake it and
  never touch the real codex binary.
- Timeout/abort kills the whole process group (spawn `detached`, signal `-pid`),
  escalating SIGTERM → SIGKILL after a grace period, because codex spawns
  subprocesses.
- The prompt is built deterministically from the Task (objective, constraints,
  acceptance criteria, plus explicit "isolated worktree / no git commands / stay in
  the worktree" rules).

Lot 5 added `src/cli/` (`conjunction` bin): `run`, `status`, `doctor`, hand-rolled
arg parsing. Run metadata is persisted as `.conjunction/runs/<runId>.json` (rewritten
at each state change) plus `<runId>.events.jsonl` (appended) — the "optionally
serialize run metadata/events to `.conjunction/`" the architecture doc allows, no
database. Verified end-to-end against real codex-cli 0.144.1: a smoke task
("create hello.txt containing hello conjunction") completed in a temp repo — branch
`conjunction/<runId>` created, file written inside the worktree only, metadata and
events persisted, summary printed, user's branch untouched.

## Lot 6 — bounded correction loop (as implemented)

**Decision: one Run, bounded correction attempts** — a deliberate reinterpretation
of the handoff's "Run = one attempt". A Run is now one orchestrated execution of a
task, which may include bounded correction attempts. Rationale: the user's unit of
work is "run this task"; splitting corrections into separate Runs sharing a worktree
would complicate cleanup semantics, branch naming (`conjunction/<runId>` stays
unique), and the TUI/status UX, for no correctness gain. Both attempts are recorded
on the run (`run.attempts[]`, persisted in the run JSON), so nothing is hidden.

Design:

- **State machine** gained one state: `correcting`. Transitions:
  `verifying → correcting` (only when correction is enabled and the cap allows) and
  `correcting → verifying | failed | cancelled`. From `correcting` there is no path
  back to `running`/`pending` and no self-loop — a cycle is structurally impossible,
  and `MAX_CORRECTIONS_PER_RUN = 1` is enforced by the orchestrator on top.
- **Events**: `correction.started` / `correction.completed`, payloads
  `{ attemptIndex, failedCommands }`. Existing events untouched; `agent.started` /
  `agent.output` / `agent.completed` fire for the correction attempt as well.
- **Correction packet** (`buildCorrectionPacket`, pure, in `src/core/correction.ts`):
  original objective/constraints/acceptance criteria; ONLY the failed commands with
  name, command line, exit state, and bounded stdout/stderr tails (last 200 lines /
  20k chars each); passing checks summarized in one line; explicit "fix, don't redo"
  framing; the same workspace/git-safety rules as the initial prompt. The previous
  agent transcript is never included.
- **Adapter seam**: `AgentRunInput.correctionPacket` replaces the task-derived
  prompt when set — prompt ownership stays in the adapter.
- **CLI**: correction is on by default when at least one `--verify` is given
  (`--no-correct` disables; no verification → nothing to correct against). Plain
  mode logs `--- correction (attempt 2/2) ---` boundaries; the TUI shows a
  `CORRECTING (attempt 2/2)` phase, keeps streaming agent output, resets the
  verification pane for the re-check, and notes the attempt count in the final
  panel. Exit codes unchanged: 0 only if the FINAL verification passes.

## TUI (Ink) — dependency decision

`conjunction run` renders an interactive TUI when stdout is a TTY (plain text
otherwise, plus a `--plain` escape hatch). New dependencies: `ink` + `react`
(runtime), `ink-testing-library` + `@types/react` (dev). Justification per the
repo's dependency discipline:

- **Why not stdlib / ANSI-by-hand:** the UI needs a scrollable auto-following
  output pane, spinners, elapsed timer, keyboard input and a final panel that
  stays readable while new output arrives. Hand-rolled ANSI means owning
  cursor addressing, line-wrap accounting, resize handling and raw-mode key
  parsing — a large, bug-prone surface that is not the product. Ink gives a
  retained layout model (React) over the terminal for less code than the ANSI
  scaffolding alone.
- **Does it couple core to anything?** No. All UI code lives in `src/cli/ui/`
  and is loaded through a dynamic `import()` only on the TTY path — the plain
  path, tests and CI never load ink/react. The TUI consumes the existing seams
  (`RunObserver` callbacks on `runTask`, the run/task objects, verification
  per-command callbacks); core/workspace/verification/adapters contain zero UI
  references. The only engine changes were narrow, UI-agnostic seams:
  `onCommandStart`/`onCommandEnd` on `runVerification` and an optional
  `AbortSignal` on `runTask` (which also fixes Ctrl-C cancellation in plain
  mode).
- **Is it removable?** Yes — delete `src/cli/ui/` and the dynamic import; the
  plain path is fully independent and is what the test-suite exercises.
- **Also considered:** raw ANSI (rejected, see above), `blessed`/`node-blessed`
  (older imperative widget model, weaker maintenance), and Ink alternatives like
  OpenTUI (younger, native deps). Ink is the conservative mainstream choice and
  v7 supports node >= 22 / ESM / React 19, matching our toolchain.

## Original Lot 4 contract sketch (historical)

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
