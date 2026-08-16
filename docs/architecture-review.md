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

- Multi-agent orchestration, planner, scheduler, message bus. The role/workflow
  vocabulary exists (`src/core/workflow.ts`) and names the future coordinator
  role `driver`, but no Driver invocation is produced yet;
  `docs/brief-workflow-design.md` §8 specifies the next slice.
- Additional agent adapters beyond Codex and Claude Code (opencode, …).
- Landing changes (committing/merging a run's worktree diff to the user's branch).
- Configuration file (`conjunction.toml` or similar) — verification commands are
  CLI flags for now.
- `.conjunction/` is not auto-added to the host repo's exclude file; in user repos it
  will show as untracked until that is handled.
- Durable/resumable state: run metadata is persisted as JSON/JSONL, but an
  interrupted CLI process cannot resume a run.
- Graphical/operator UI of any kind (the terminal TUI exists for `run`).

## Consolidation pass (post-lot-7 audit)

Behavior changes from the audit, recorded here so the docs don't drift:

- **State machine:** added `verifying → cancelled` — user abort is now possible
  from every non-terminal state (its omission made abort mid-verification
  uncancellable).
- **Abort during verification now works:** `runVerification` forwards the
  AbortSignal to `execFile` (killing the running command), the CLI's verify
  port rethrows on abort so the run never transitions to `failed`, and the CLI
  maps any abort to `cancelRun`. Abort checks also guard every phase boundary.
- **Reviewer diff includes untracked files.** `git diff HEAD` alone omitted
  them — and agents mostly create new files, so reviewer packets were
  effectively empty for new-file tasks. `getWorktreeDiff` now appends
  synthetic new-file diff sections (binary files listed, not dumped).
- **Cleanup is idempotent and partial-failure tolerant:**
  `removeRunWorkspace` skips a worktree that is already gone and a branch that
  is already deleted.
- **Persistence is best-effort:** an unwritable `.conjunction/runs` directory
  warns once and the run continues without metadata instead of crashing
  mid-run.
- **Dedupe:** the failed-verification predicate (`isFailedVerificationResult`)
  and per-severity finding counts (`countFindingsBySeverity`) are single-sourced
  in core.

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
- **Adapter seam:** superseded by V1 Lot 1. Conjunction now passes prepared
  `AgentRunInput.instructions`; adapters no longer know how `Task` becomes
  prompt text.
- **CLI**: correction is on by default when at least one `--verify` is given
  (`--no-correct` disables; no verification → nothing to correct against). Plain
  mode logs `--- correction (attempt 2/2) ---` boundaries; the TUI shows a
  `CORRECTING (attempt 2/2)` phase, keeps streaming agent output, resets the
  verification pane for the re-check, and notes the attempt count in the final
  panel. Exit codes unchanged: 0 only if the FINAL verification passes.

## Lot 7 — independent reviewer (as implemented)

**Decisions applied (and why):**

1. **Opt-in via `--review`.** A review is a second paid agent call; default runs
   stay fast/cheap. `--review` without `--verify` is allowed (review stands alone
   after the agent attempt, via the vacuous verification pass).
2. **Review only after the FINAL verification passed.** New state `reviewing` with
   exactly two new edges: `verifying → reviewing` (pass + review enabled) and
   `reviewing → completed | cancelled`. (The consolidation pass later added
   `verifying → cancelled` for mid-verification abort; see that section.) No
   `running → reviewing` edge: the no-verify path goes through the (vacuous)
   verifyRun like everything else, so one entry point suffices. Failed verification
   (correction exhausted or disabled) never reviews.
3. **Advisory by construction.** Findings never change the exit code and never
   feed the correction loop. Reopening self-healing via review findings is
   explicitly future work (a bounded review-driven second correction would need
   a separate cap, not a loosening of `MAX_CORRECTIONS_PER_RUN`).
4. **Same adapter, read-only, structured.** `AgentRunInput` carries prepared
   `instructions`, `readOnly` (codex maps to `-s read-only`; the adapter can
   only ever emit `workspace-write` or `read-only`) and `outputSchema`
   (runtime-agnostic JSON Schema; codex writes it to a temp file and passes
   `--output-schema`).
   The reviewer's prompt (`buildReviewerPacket`, pure) carries objective +
   constraints + acceptance criteria + the bounded worktree diff (2000 lines /
   100k chars, truncation marker) + a one-line-per-command verification summary.
   The implementer transcript is structurally absent from the input type.

**Reviewer-failure policy:** a reviewer crash/timeout/malformed-output never
fails the run. Crash/timeout → `run.review.error` + `review.completed` with
`errored: true`, run completes (plain output shows `• Review unavailable
(advisory)`). Malformed output → `parseReviewReport` falls back to one
unstructured finding holding the raw text (`structured: false` on
`run.review`). Abort (q / Ctrl-C) is the only reviewer outcome that changes the
run — it cancels it.

Findings persist on the run (`run.review: { summary, findings, structured,
completedAt, agentResult, error? }`) and counts flow through the
`review.started` / `review.completed` events.

## Briefs, workflows and roles (as implemented)

Full decision record: `docs/brief-workflow-design.md`. Summary of what changed
in the architecture:

- **Task input is now a brief.** `conjunction run ./brief.md`,
  `--brief <file>`, or the historic inline string. The brief's text is used
  **verbatim** as `task.objective` — there is no markdown parser, on purpose
  (heading names are a convention, not a contract, and nothing consumes
  structured fields yet; see §4.1 of the design doc).
- **`Task.source?: TaskSource`** (`{kind:"inline"} | {kind:"file";path}`) —
  provenance only, optional because runs recorded earlier have none. The brief
  content is not stored twice: `task.objective` is what actually reached the
  prompts.
- **`src/core/workflow.ts`** introduces the role vocabulary: `Role`
  (`driver | worker | critic`), `WorkflowName` (`single | review`), and a
  hard-coded `WORKFLOWS` table. `driver` is the canonical future coordinator
  name, but no workflow emits it yet. Core owns the vocabulary;
  `src/cli/run-command.ts` keeps owning the phase sequence and now derives
  `review` from `workflowIncludes(workflow, "critic")`.
- **`Run.workflow?: WorkflowName`** persisted, optional for older runs.
- **Correction is not a workflow and not a role** — it is the worker responding
  to deterministic feedback, so it belongs to every workflow and `--no-correct`
  stays orthogonal.
- **Brief loading lives in `src/cli/brief.ts`**, the composition root, next to
  the other input resolution (`--verify`, `--repo`). Core stays I/O-free; a test
  in `tests/core/workflow.test.ts` now enforces that (no adapter/UI imports, no
  `node:fs`/`child_process`/`http` in core).
- **`objectiveSection()`** in `src/core/task.ts` single-sources how a brief is
  framed in the three packets (worker prompt, correction, reviewer): a
  file-sourced brief is announced as `## Brief (<path>)` instead of being nested
  under `## Objective`, so the brief's own headings don't collide.

Deliberately NOT built (specified in the design doc instead): intelligent
routing, `ContextPacket`, `Plan`/`Subtask`/`SubtaskResult`/`DriverDecision`, a
`WorkflowExecutor` extraction, a workflow DSL, and the Driver itself.

## V1 Lot 1 — execution model harness

This pass keeps the existing single-runtime workflow but records agent work as
explicit invocations:

- **`Invocation` is the unit of agent execution.** New runs carry
  `run.invocations[]` for the worker attempt, optional correction worker
  attempt, and optional read-only critic. The older `run.runtime` and
  `run.attempts[]` remain for compatibility/status surfaces; attempts link back
  with `attempt.invocationId`.
- **Role / Runtime / Model / Effort are separated.** `Invocation.role` is
  `driver | worker | critic`; `Invocation.target` is an opaque
  `ExecutionTarget { runtime, model? }`; `Invocation.reasoningEffort` is the
  portable Conjunction intent (`minimal | low | medium | high | maximum`).
  Current CLI runs record `medium`; no adapter flag is emitted for effort until
  a runtime can truthfully support it.
- **Prompt ownership moved out of adapters.** Core builds worker instructions in
  `buildWorkerInstructions`; correction and critic packets were already core
  builders. `AgentRunInput` now receives `instructions` only. The Codex adapter
  only transmits them via `codex exec`.
- **Quality harness:** Vitest architecture tests now enforce core → no concrete
  adapters/CLI and workspace/verification → no core. A reusable adapter contract
  suite covers structured process outcome, cancellation, timeout, streaming,
  read-only mode, instruction transmission, no pass/fail decision, and no
  Git/worktree lifecycle knowledge; Codex passes it through a fake spawner.

## V1 Lot 2 — multi-runtime execution

This pass keeps the same serial workflow, but invocation targets are now real:

- **RuntimeRegistry:** core defines the tiny `RuntimeRegistry` port and
  `StaticRuntimeRegistry` implementation (`runtime id -> AgentAdapter`). The
  CLI wires concrete adapters; core never imports Codex or Claude.
- **Target resolution and capability boundary:** `runTask` selects explicit
  worker and critic targets from CLI options. `Orchestrator` resolves the
  adapter from the requested target before creating an `Invocation`, then checks
  the runtime capabilities required by that invocation: explicit reasoning
  effort, read-only execution, and structured output. Correction inherits the
  initial worker invocation target; critic may use a distinct target.
- **Events:** `agent.started`, `agent.output`, and `agent.completed` all carry
  `invocationId`, so stdout/stderr chunks are attributable even when multiple
  runtimes participate in one run.
- **Adapters:** Codex now reads `input.target.model`; it no longer carries model
  in the constructor. Claude Code was added as the second concrete adapter using
  installed/official CLI flags (`claude -p`, `--model`, `--effort`,
  `--permission-mode`, `--tools`, `--json-schema`). When Conjunction requests a
  schema, Claude uses `--output-format json` and the adapter extracts
  `structured_output` from Claude's transport envelope before returning
  `AgentRunResult.lastMessage`.
- **Capabilities:** adapters expose `AgentCapabilities`. Codex supports
  read-only and structured output but declares no reasoning-effort mapping.
  Claude supports read-only, structured output, and maps Conjunction
  `low|medium|high|maximum` to Claude `low|medium|high|max`; `minimal` is not
  mapped.
- **Claude Code headless limit:** the current non-interactive Claude mode can
  perform edits with the selected permission mode. Non-trivial Bash command
  access still needs an explicit future policy; Conjunction deliberately does
  not grant a global `--allowedTools Bash`.

`examples/chessquest/brief.md` is a benchmark brief used to compare workflows on
identical input. Conjunction does not build that application.

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
