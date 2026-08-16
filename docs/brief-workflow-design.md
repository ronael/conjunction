# Briefs, Workflows and Roles — Design

Design record for the `feat/brief-workflows` branch: moving task input from a
CLI string to a **brief** (file or inline), naming the existing capability
combinations as **workflows**, and introducing **roles** as the vocabulary a
future Supervisor will key off.

This document is the decision record. It states what was built, what was
deliberately _not_ built, and which prompt suggestions were rejected.

---

## 1. Current state (before this branch)

### How a task enters Conjunction

```
argv  →  cli.ts (parseArgs)  →  description: string
      →  runTask({ description, … })                       src/cli/run-command.ts
      →  orchestrator.createTask({ title, objective })      src/core/orchestrator.ts
      →  createTask()                                       src/core/task.ts
      →  orchestrator.createRun(task.id, adapter.id)
```

`cli.ts:64` is the whole of it: `parsed.positionals.join(" ").trim()`. That one
string becomes both `task.title` (truncated to 80 chars) and `task.objective`.
Every downstream role reads `task`, never the original argv.

### How it reaches the worker

`runTask` (the composition root for a run) drives an explicit, hard-coded phase
sequence:

```
findRepoRoot → record baseBranch/baseCommit → orchestrator.startRun (worktree)
  → orchestrator.executeRun         (attempt 1, prompt built from Task)
  → orchestrator.verifyRun          (deterministic commands, fail-fast)
  → [correcting] executeCorrection  (attempt 2, buildCorrectionPacket)
  → [correcting] verifyRun          (terminal, cap = 1)
  → [reviewing]  reviewRun          (buildReviewerPacket, read-only, advisory)
  → summary + persistence + optional cleanup
```

The `AgentAdapter` port (`src/core/agent.ts`) receives `{ task, workspacePath,
timeoutMs, signal?, onOutput?, promptOverride?, readOnly?, outputSchema? }`.
The Codex adapter turns `task` into a prompt in `src/adapters/codex/prompt.ts`;
correction and review supply `promptOverride` instead, built by pure functions
in core (`buildCorrectionPacket`, `buildReviewerPacket`).

### Which structures carry objective / constraints / acceptance criteria

Only `Task` (`src/core/task.ts`):

```ts
interface Task {
  readonly id: string;
  title: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  relevantPaths?: string[];
  verificationExpectations?: string[];
  status: TaskStatus;
}
```

**Important finding:** the CLI has never populated `constraints`,
`acceptanceCriteria`, `relevantPaths` or `verificationExpectations`. They are
always `[]`/`undefined` in practice. The three prompt builders each render them
as markdown bullets and fall back to `- None specified.` / `- The objective
above is fulfilled.`. So the structured fields exist, are rendered as markdown,
and have no producer. This directly shapes decision §4.1 below.

### Responsibilities today

| Module                    | Owns                                                                                                                                                      | Must not                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `src/core/`               | Task, Run + state machine, EventStore, Orchestrator, correction/review packet builders, ports (`WorkspaceProvider`, `VerificationRunner`, `AgentAdapter`) | import any adapter, do I/O, know about a UI |
| `src/workspace/`          | git worktrees, diff, land patch                                                                                                                           | import core                                 |
| `src/verification/`       | running deterministic commands                                                                                                                            | import core                                 |
| `src/adapters/<runtime>/` | one runtime (process spawn, prompt rendering, flags)                                                                                                      | judge pass/fail, know about branches/events |
| `src/cli/`                | composition root: arg parsing, wiring, phase sequence (`runTask`), persistence (`RunStore`)                                                               | —                                           |
| `src/cli/ui/`             | Ink TUI, fed only through `RunObserver`                                                                                                                   | be known by the engine                      |

Persistence is `.conjunction/runs/<runId>.json` (task + run, rewritten at each
state change) plus `<runId>.events.jsonl`. No database, no index.

---

## 2. Gap analysis

Target:

```
Brief  →  Workflow  →  Roles  →  (future) Supervisor
```

| #   | Gap                                                                                                                                                                | Severity                  | Addressed in this branch                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------- |
| 1   | Task text can only come from argv. No file input, no provenance recorded.                                                                                          | blocking                  | **yes**                                               |
| 2   | A persisted run cannot say _which brief_ produced it.                                                                                                              | blocking for benchmarking | **yes** (`task.source`)                               |
| 3   | Which capabilities participate is expressed as flag arithmetic (`--review`, `--no-correct`, "correction is on iff `--verify` given"). No name for a configuration. | high                      | **yes** (`--workflow`)                                |
| 4   | No vocabulary for _roles_. Reviewer independence is a real architectural property but is encoded as `readOnly: true` + a packet shape, not as a named participant. | medium                    | **partially** (`Role` type, workflow → roles)         |
| 5   | Role → runtime → model is collapsed: one adapter, one `--model` flag, applied to every invocation.                                                                 | medium                    | **no** — documented (§5)                              |
| 6   | The phase sequence is hard-coded inside `runTask`, interleaved with plain-text rendering. A Supervisor cannot reuse it.                                            | high                      | **no** — documented (§7), deliberately not refactored |
| 7   | No plan/subtask model; a run is one objective end to end.                                                                                                          | expected                  | **no** — designed only (§8)                           |
| 8   | Context packets exist for correction and review but not as a named concept.                                                                                        | low                       | documented (§6)                                       |

Gaps 5–7 are the Supervisor's job. Closing them now would mean rewriting the
orchestrator for a consumer that does not exist.

---

## 3. Principles applied

- No provider-specific logic in `src/core/` — `Role` and `WorkflowName` are
  runtime-agnostic; no adapter is named anywhere in core.
- The Orchestrator is **not** rewritten. It gains one optional constructor-time
  field on `createRun` and nothing else.
- No DB, no parallelism, no scheduler, no message bus, no graph framework, no
  YAML DSL, no plugin system.
- Every new concept must have a producer and a consumer **today**. Concepts with
  only a hypothetical consumer are written down here instead of in `src/`.
- Determinism: brief loading, title derivation, workflow resolution and packet
  building are all pure/deterministic and unit-tested.

---

## 4. The Brief model

### 4.1 Decision: the brief stays opaque text (option A)

The prompt offered three options: (A) opaque text, (B) extract minimal fields,
(C) a complementary structured format. **A is chosen.**

Why not B (parse `## Constraints`, `## Acceptance Criteria` into `Task` fields):

1. **Heading names are a convention, not a contract.** A brief that says
   `## Guardrails` or `## Ce qui ne doit pas casser` would silently lose its
   constraints. Silent partial extraction is worse than no extraction: the
   worker still gets the full text either way, but the _system_ would believe it
   has structured constraints when it does not.
2. **It creates duplication or loss.** The prompt builders render
   `task.objective` _and_ `task.constraints`. Extracting into both means the
   constraints appear twice in every prompt; extracting into constraints only
   means dropping them from the preserved original — which violates the "keep
   the brief intact" requirement.
3. **Nothing consumes the structure.** Today `constraints` and
   `acceptanceCriteria` are only ever re-rendered as markdown bullets. A brief
   _is already_ markdown bullets. Parsing markdown into strings to re-emit them
   as markdown is a lossy round-trip with zero gain.
4. **The real trigger is different.** Structured fields start paying off when a
   _program_ consumes them — e.g. a Lead assigning specific acceptance criteria
   to subtask 3 of 5. That is Supervisor work, and when it lands the structure
   should be **explicit** (YAML front-matter or a sidecar the author opts into),
   not sniffed from headings.

Why not C (a complementary structured format) _now_: same reason — no consumer.
It is pre-designed in §8 so it can land without a rewrite.

**Consequence:** `task.objective` holds the brief **verbatim**, whitespace and
all. Nothing is dropped, and no run can lose context to a parser bug — there is
no parser.

### 4.2 Decision: `Brief` is a CLI-layer value, not a core entity

The prompt suggested `interface Brief { source; content; … }`. It was not
copied blindly. Two things need to exist, and they are not the same thing:

- **loading** a brief (filesystem, size bounds, encoding, error messages) —
  input resolution, which is exactly what `src/cli/` already does for `--verify`
  and `--repo`. Lives in `src/cli/brief.ts`.
- **provenance** on the persisted model — one field, so a stored run says which
  brief produced it. Lives in `src/core/task.ts`.

So:

```ts
// src/core/task.ts — persisted, minimal
export type TaskSource =
  | { kind: "inline" }             // description typed on the command line
  | { kind: "file"; path: string } // absolute path of the brief file

interface Task { …; source?: TaskSource }   // optional: runs recorded before
                                            // this branch have no source
```

```ts
// src/cli/brief.ts — transient, never persisted as such
export interface Brief {
  readonly source: TaskSource;
  readonly content: string; // the full, unmodified brief text
  readonly title: string; // display label only, ≤ 80 chars
}
```

`Brief` is not a core entity because it has no lifecycle, no identity and no
state — it is the _input_ from which a `Task` is normalized. `Task` is already
"a user's desired outcome after normalization". Adding a second entity that
means the same thing one step earlier would be duplication, not abstraction.

**Challenge answered (#1 — do we really need a `Brief` type?)** — a `Brief` type
that _only_ existed to carry a string would not earn its place. It earns it by
bundling three values produced together by one loader and consumed together by
one call site, which keeps `RunTaskOptions` from growing three parallel fields
(`description`, `briefPath`, `briefTitle`) that can drift out of sync.

### 4.3 What is not persisted, and why that is safe

The brief **content** is persisted — as `task.objective`, verbatim, in
`.conjunction/runs/<runId>.json`. The **path** is persisted as `task.source`.
No separate copy of the file is stored: a second copy could disagree with
`objective`, and `objective` is what actually went into the prompts. The run
record is therefore self-contained even if the brief file is later edited or
deleted.

### 4.4 Title derivation

`title` is a display label (status listing, TUI header, summary). Derivation,
in order:

1. the first ATX `# Heading` in the first 20 lines of a file brief;
2. otherwise the file's basename;
3. for inline briefs, the description itself;

then trimmed and truncated to 80 chars with `…`.

This is **one regex for a label**, never for semantics. No branch, prompt or
verification decision reads `title`. It is explicitly not a markdown parser and
must not grow into one.

### 4.5 Loading contract

| Condition               | Behavior                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| file missing            | `error: brief file not found: <path>` — exit 2                       |
| path is a directory     | `error: brief path is a directory, expected a file: <path>` — exit 2 |
| empty / whitespace only | `error: brief file is empty: <path>` — exit 2                        |
| > 256 KiB               | `error: brief file is too large (N KiB > 256 KiB): <path>` — exit 2  |
| contains a NUL byte     | `error: brief file does not look like UTF-8 text: <path>` — exit 2   |
| leading UTF-8 BOM       | stripped, content otherwise untouched                                |
| relative path           | resolved against the **process cwd**, not `--repo`                   |

No network access, ever: the loader only calls `stat` + `readFile`. A `http(s)://`
brief was considered and rejected — it would make a run depend on a mutable
remote and break reproducibility.

256 KiB is roughly 60k tokens of prose: far beyond any sane brief, far below
anything that could exhaust memory. It is a guard rail, not a budget.

### 4.6 CLI surface, and the positional ambiguity

**Challenge answered (#2 — does the positional form create ambiguity?)** Yes, it
genuinely does, so the heuristic is tight, documented and never silently falls
back:

```
conjunction run ./briefs/chessquest.md          # brief file (path-like)
conjunction run --brief ./briefs/chessquest.md  # brief file (explicit, no guessing)
conjunction run "fix authentication bug"        # inline description
```

A single positional is treated as a brief file **iff** it starts with `./`,
`../`, `/` or `~/`, **or** contains no whitespace and ends with `.md` /
`.markdown` / `.txt`. If it looks like a path and the file does not exist, the
run **fails** — it is never re-interpreted as a task description. Silent
fallback is the dangerous option: a typo'd path would become a garbage
objective and burn a real agent call.

The whitespace clause is not cosmetic: the existing test-suite task
`"create a file hello.txt"` ends in `.txt` and is unambiguously a description.
A path containing spaces must therefore use `./` or `--brief`, which is a
reasonable price for never misreading a sentence as a filename.

Both forms are kept, with different jobs: `--brief` is the unambiguous form
(always a file, no heuristic); the positional is convenience for the common
case. Supplying both is a usage error. The rejected alternative — `stat()` every
positional and treat any existing file as a brief — would turn the task
description `"README.md"` into a brief by accident.

Inline runs are unchanged: `conjunction run "fix authentication bug"` behaves
exactly as before, and `task.source` is `{ kind: "inline" }`.

---

## 5. Workflows, and the Role / Runtime / Model split

### 5.1 Decision: `--workflow` now, as a name for what already exists

**Challenge answered (#3 — is `--workflow` premature?)** It would be premature
if it introduced _capabilities_. It does not. Conjunction already selects
between four capability combinations, expressed as flag arithmetic:

```
(no flags)                   worker + verification + correction
--no-correct                 worker + verification
--review                     worker + verification + correction + critic
--review --no-correct        worker + verification + critic
```

`--workflow` gives two of those combinations a name. That is a renaming of the
present, not a bet on the future — the cheapest possible abstraction, and the
slot the Supervisor plugs into later.

```ts
// src/core/workflow.ts
export type Role = "worker" | "critic";
export type WorkflowName = "single" | "review";

export interface WorkflowDefinition {
  readonly name: WorkflowName;
  readonly roles: readonly Role[];
  readonly description: string;
}
```

| Workflow           | Roles              | Pipeline                                                                 |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `single` (default) | `worker`           | worker → verification → (bounded correction) → land                      |
| `review`           | `worker`, `critic` | worker → verification → (bounded correction) → independent critic → land |

`lead` is deliberately **absent from the `Role` union**. Adding a value no
producer emits would be the speculative abstraction this branch is supposed to
avoid; adding it later is a one-word change plus a workflow entry.

### 5.2 Where correction lives — an explicit decision

Correction is **not a role and not a workflow**. It is a bound on the worker's
response to _deterministic_ feedback: the same worker, same worktree, same
role, one extra attempt, capped at `MAX_CORRECTIONS_PER_RUN = 1`.

Therefore correction is part of **every** workflow, and `--no-correct` remains
an orthogonal modifier that tightens the bound to zero. Making `single` mean
"no correction" was considered and rejected: it would silently change today's
default behavior, and it would conflate "which participants" with "how many
attempts a participant gets".

Precise rule (unchanged from before this branch): correction runs iff at least
one `--verify` command is configured and `--no-correct` is absent. Without
verification there is nothing deterministic to correct against.

### 5.3 Backwards compatibility of `--review`

`--review` is kept as an alias for `--workflow review`. If both are given and
they disagree (`--workflow single --review`), that is a usage error rather than
a silent precedence rule. Agreement (`--workflow review --review`) is accepted.

### 5.4 Where the workflow → behavior mapping lives

**Challenge answered (#5).** Split by nature:

- **core** owns the _vocabulary_: `Role`, `WorkflowName`, the `WORKFLOWS` table,
  `isWorkflowName`, `getWorkflow`, `workflowIncludes`. Pure data + pure
  predicates. No adapter, no I/O, no phase logic.
- **`src/cli/run-command.ts`** owns the _interpretation_: it already owns the
  phase sequence, and it now derives `review` from
  `workflowIncludes(workflow, "critic")` instead of from a boolean option.

The phase sequence is deliberately **not** moved into core in this branch. That
move is a real refactor with a real trigger (§7), and doing it speculatively is
exactly the orchestrator rewrite the branch forbids.

**Challenge answered (#4 — hard-coded workflows?)** Yes, hard-coded, in one
exhaustively-typed table. A config file or DSL earns its place when a workflow
needs to carry _per-role runtime/model assignments_ — i.e. with the Lead. Until
then a DSL would be a configuration language with nothing to configure.

### 5.5 Role ≠ Runtime ≠ Model

The constraint holds structurally today:

| Concept                                | Where it lives now                                                                                                                                               | Where it will live          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Role** — what the participant is for | `Role` in `src/core/workflow.ts`; enforced by packet shape (`buildReviewerPacket` has no field for the worker transcript) and by `readOnly: true` for the critic | unchanged                   |
| **Runtime** — how it is executed       | `AgentAdapter` implementations, `Run.runtime`                                                                                                                    | a `RoleAssignment` per role |
| **Model** — which AI                   | `--model`, passed to the adapter constructor                                                                                                                     | a `RoleAssignment` per role |

`RoleAssignment { role, adapter, model }` is **not implemented**. With exactly
one adapter and one `--model` flag it would be a mapping with a single possible
value — a lookup table that can only return one answer. It is specified in §8.2
and lands with the Supervisor, when a second runtime or a per-role model gives
it a second possible value.

Nothing named `CodexWorker` or `ClaudeReviewer` exists or may exist in core.
Core names roles; adapters name runtimes; the CLI wires the two together.

### 5.6 Persistence

`Run.workflow?: WorkflowName` — optional, because runs recorded before this
branch have none. `undefined` is displayed and treated as `single` (which is
what those runs actually did unless `--review` was passed; that nuance is not
worth a migration, and the `review` field on the run record still shows what
happened).

**Challenge answered (#6 — is `Run` still the right persistence level?)** Yes,
for this branch. A run is still "one orchestrated execution of one objective";
briefs and workflows are _inputs_ to that, not new lifecycles. It stops being
the right level when a Lead produces a plan whose subtasks each need their own
worktree, verification and audit — then a run owns a plan and subtask results
become its children (§8.1), which is still one file per run, still no database.

---

## 6. Source of truth and context packets

The brief is the **single source of truth**, held verbatim in `task.objective`
and reachable by every role. What differs per role is the _bounded extra
context_ — which today is already the design:

| Role                | Gets                                                                                                         | Structurally cannot get                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| worker (attempt 1)  | brief + workspace rules                                                                                      | —                                                                                    |
| worker (correction) | brief + failed commands with bounded stdout/stderr tails + one-line list of passing checks + workspace rules | its own previous transcript (never assembled)                                        |
| critic              | brief + bounded worktree diff (2 000 lines / 100 KiB) + one-line-per-command verification summary            | the worker's transcript — `buildReviewerPacket`'s input type **has no field for it** |

That last column is the important property: independence is enforced by the
_shape of the input type_, not by a convention someone must remember. This
branch preserves it and does not generalize it.

**Deliberately not built: a `ContextPacket` abstraction.** With two packet
builders, both pure, both fully tested, a common interface would be an
indirection over two functions that share no logic beyond "join lines". The
trigger to introduce it: when a third and fourth packet appear (lead planning
packet, lead audit packet) and duplication becomes measurable. At that point the
shape is likely:

```ts
interface ContextPacket {
  role: Role;
  brief: string; // always, verbatim
  scope?: string; // the subtask, when a plan exists
  evidence: string[]; // diff, verification output, findings — bounded
}
```

with a per-role renderer. Written here, not in `src/`.

The anti-goals stay explicit: no accumulated transcripts, no implicit context,
no self-validation by the worker.

---

## 7. Keeping the Orchestrator from becoming a god class

**Challenges answered (#7, #8).** The risk is real and the current shape makes
it worse than it looks: `Orchestrator` is fine (it drives one run's state
machine), but `runTask` in `src/cli/run-command.ts` is 330 lines that mix three
responsibilities — phase sequencing, plain-text rendering, and persistence
flushing. A Supervisor bolted onto that would inherit all three.

Planned separation, **not done in this branch**:

```
Supervisor            plans, audits, decides go/stop        (does not exist yet)
    ↓ drives
WorkflowExecutor      the phase sequence, UI-free           (today: inline in runTask)
    ↓ drives
Orchestrator          one run's state machine + events      (exists, unchanged)
    ↓ ports
Workspace / Verification / AgentAdapter                     (exist, unchanged)
```

The trigger for extracting `WorkflowExecutor` is the first workflow whose phase
sequence is not a subset of today's — i.e. `quality`, which inserts Lead phases
before and after. Extracting it earlier would produce an executor with exactly
one shape, validated by nothing. Yes, `ExecutionOrchestrator` and `Supervisor`
should ultimately be separate objects: one owns _a_ run, the other owns _a
sequence of runs and the decision to continue_.

---

## 8. Supervisor v0 — proposed, not implemented

Sequential only. One worker active at a time. No parallelism, no dependency
graph, no distributed state.

```
Brief → Lead → structured Plan
             → subtask 1 → worker → verification → Lead audit → decision
             → subtask 2 → worker → verification → Lead audit → decision
             → final audit → land
```

### 8.1 Minimal data model

```ts
interface Plan {
  readonly id: string;
  readonly runId: string;
  createdAt: string;
  /** The Lead's restatement of the objective — never replaces the brief. */
  summary: string;
  subtasks: Subtask[];
}

interface Subtask {
  readonly id: string;
  index: number; // execution order; sequential, no dependencies
  title: string;
  objective: string; // scope only — the brief stays the source of truth
  acceptanceCriteria: string[]; // what the Lead will audit against
  verifyCommands?: string[]; // deterministic gate for THIS subtask, if any
}

interface SubtaskResult {
  readonly subtaskId: string;
  attemptCount: number;
  agentResult: AgentAttemptOutcome;
  verification?: VerificationOutcome;
  diffSummary: string; // bounded; the audit packet's evidence
  completedAt: string;
}

type SupervisorVerdict = "accept" | "retry" | "stop";

interface SupervisorDecision {
  readonly subtaskId: string;
  verdict: SupervisorVerdict;
  reason: string; // always required — decisions are inspectable
  /** Bounded guidance for the single retry; never the worker's transcript. */
  guidance?: string;
  decidedAt: string;
}
```

Rules that must hold on day one:

- deterministic verification remains the arbiter for anything it can decide —
  the Lead may reject a green subtask, but may **not** accept a red one;
- `retry` is capped per subtask (same discipline as `MAX_CORRECTIONS_PER_RUN`);
- `stop` is terminal and must carry a reason; the run ends `failed`, not
  silently `completed`;
- every decision is persisted and emitted as an event — no invisible judgment;
- the plan is produced once, up front. Re-planning mid-run is v1 at the earliest.

None of this is implemented. `Plan`, `Subtask`, `SubtaskResult` and
`SupervisorDecision` are absent from `src/` on purpose: no workflow in this
branch produces or consumes them.

### 8.2 `RoleAssignment`, when it lands

```ts
interface RoleAssignment {
  role: Role; // lead | worker | critic
  adapter: AgentAdapter; // runtime
  model?: string; // model + runtime-specific options
}
```

Resolution order: workflow default → config file → CLI override. It arrives
with the Lead, because that is the first moment two roles need _different_
runtimes or models.

---

## 9. Rejected ideas (summary)

| Idea                                                                               | Verdict            | Why                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| Markdown heading parser for `## Constraints` etc.                                  | rejected           | convention, not contract; duplicates or loses text; no consumer (§4.1)              |
| `Brief` as a core entity                                                           | rejected           | no identity, no lifecycle, no state — it is `Task`'s input (§4.2)                   |
| Storing a second copy of the brief file next to the run                            | rejected           | can disagree with `task.objective`, which is what actually reached the prompts      |
| `stat()`ing every positional to detect briefs                                      | rejected           | turns the description `"README.md"` into a brief by accident (§4.6)                 |
| Falling back to "treat it as a description" when a path-like positional is missing | rejected           | a typo would burn a real agent call on a garbage objective                          |
| Fetching briefs over http(s)                                                       | rejected           | mutable remote breaks run reproducibility; no network in the engine                 |
| `--workflow quality` registered now                                                | rejected           | names a pipeline that cannot run; unknown-workflow error is more honest             |
| `lead` in the `Role` union                                                         | rejected (for now) | no producer; one-word change when the Lead lands (§5.1)                             |
| `RoleAssignment` implemented now                                                   | rejected           | one adapter + one model = a mapping with one possible value (§5.5)                  |
| YAML/DSL workflow definitions                                                      | rejected           | a configuration language with nothing yet to configure (§5.4)                       |
| `ContextPacket` common abstraction                                                 | rejected           | indirection over two pure functions that share no logic (§6)                        |
| Extracting `WorkflowExecutor` now                                                  | rejected           | would have exactly one shape, validated by nothing (§7)                             |
| `single` meaning "no correction"                                                   | rejected           | silently changes today's default; conflates participants with attempt bounds (§5.2) |
| Precedence rule for `--workflow single --review`                                   | rejected           | ambiguity should be an error, not a silent winner (§5.3)                            |

**Challenge #9 — which proposed abstractions would be premature?**
`RoleAssignment`, `ContextPacket`, `Plan`/`Subtask`/`SupervisorDecision`, a
workflow DSL, and `WorkflowExecutor`. All five are specified above and none are
in `src/`.

**Challenge #10 — the smallest design that evolves without a rewrite.** Exactly
what this branch ships: one optional provenance field on `Task`, one optional
workflow field on `Run`, a two-entry workflow table with a role list, and a
brief loader in the composition root. Every future step — Lead role, per-role
assignments, plans — is an _addition_ to those, not a change of them.

---

## 10. What this branch actually ships

- `src/core/workflow.ts` — `Role`, `WorkflowName`, `WORKFLOWS`,
  `isWorkflowName`, `getWorkflow`, `workflowIncludes`.
- `src/core/task.ts` — `TaskSource`, `Task.source?`, `TaskInput.source?`, and
  `objectiveSection()` (the one place the brief is rendered into a packet
  heading, shared by the three prompt builders).
- `src/core/run.ts` — `Run.workflow?: WorkflowName`.
- `src/core/orchestrator.ts` — `createRun(taskId, runtime, workflow?)`.
- `src/cli/brief.ts` — `Brief`, `BriefError`, `loadBrief`, `resolveBrief`,
  `looksLikeBriefPath`, `deriveTitle`, `inlineBrief`.
- `src/cli/cli.ts` — `--brief`, `--workflow`, the positional heuristic,
  `--review` as an alias with conflict detection.
- `src/cli/run-command.ts` — takes a `Brief` + `WorkflowName` instead of a
  description + `review` boolean.
- TUI header rows for `Brief` and `Workflow`; `status` shows the workflow.
- `examples/chessquest/brief.md` — benchmark brief (documentation only; the
  application is not generated).

Non-goals for the branch, all respected: no parallel workers, no swarm, no
planner, no Supervisor, no queue, no scheduler, no SQLite, no server, no web
API, no remote execution, no provider marketplace, no model routing, no graph
engine, no DSL, no plugin system, no new agent framework, no TUI rewrite, no
repo-wide refactor.
