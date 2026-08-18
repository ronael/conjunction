# Using the Conjunction CLI

Build first, then use the `conjunction` bin (or call node directly):

```bash
pnpm install
pnpm build
node dist/cli/main.js --help        # or link the bin: pnpm link --global
```

Requires: node >= 20, git, and at least one supported agent runtime. The default
runtime is the [Codex CLI](https://github.com/openai/codex), installed and
authenticated (`codex --version` should work). Claude Code is also supported as
`claude-code` when `claude --version` works.

## Commands

### `conjunction doctor`

Checks that an agent runtime is installed and usable:

```bash
$ node dist/cli/main.js doctor
agent runtime "codex-cli": available (codex-cli 0.144.1)
$ node dist/cli/main.js doctor --runtime claude-code
agent runtime "claude-code": available (2.1.220 (Claude Code))
```

### `conjunction run "<task>" | <brief.md> | --brief <file>`

Executes one brief end-to-end:

1. builds a `Task` from the brief (inline description or file);
2. creates branch `conjunction/<runId>` and a worktree at
   `<repoRoot>/.conjunction/worktrees/<runId>`;
3. runs the selected worker runtime inside the worktree, streaming its output;
4. runs each `--verify` command (sequentially, fail-fast) inside the worktree;
5. prints a summary and preserves the worktree for inspection.

```bash
# inline description (unchanged)
conjunction run "create a file hello.txt containing the text hello conjunction" \
  --repo /path/to/repo \
  --verify "pnpm exec tsc --noEmit" \
  --verify "pnpm test" \
  --timeout 10

# brief file
conjunction run examples/chessquest/brief.md --workflow single
conjunction run examples/chessquest/brief.md --workflow review
conjunction run examples/chessquest/brief.md --workflow quality \
  --driver-runtime claude-code \
  --runtime codex-cli \
  --critic-runtime claude-code \
  --verify "pnpm test"

# explicit form (never guesses)
conjunction run --brief ./briefs/chessquest.md --workflow review
```

## Briefs

A brief is the run's **source of truth**. It can be an inline description or a
file — usually Markdown, but any UTF-8 text file works.

The file's content is used **verbatim**: Conjunction does not parse your
headings, and `## Constraints` / `## Acceptance Criteria` carry no special
meaning. The whole document is what every role sees, so nothing is lost to a
parser. (Rationale, and the trigger for revisiting this, are in
`docs/brief-workflow-design.md` §4.1.)

**How a positional argument is interpreted.** A single positional is read as a
brief **file** when it looks like a path — it starts with `./`, `../`, `/` or
`~/`, or it has no spaces and ends in `.md`, `.markdown` or `.txt`. Anything
else is an inline description. If it looks like a path and the file is missing,
the run fails (exit 2) rather than silently treating your typo as a task.
`--brief <file>` is always a file and never guesses; passing both `--brief` and
a description is an error.

Limits and errors (all exit 2, before any agent runs):

- file missing, path is a directory, file empty or whitespace-only;
- larger than 256 KiB;
- not UTF-8 text (contains a NUL byte). A leading BOM is stripped;
- relative paths resolve against your **current directory**, not `--repo`.

What gets recorded: the brief's full text as `task.objective`, and its absolute
path as `task.source` in `.conjunction/runs/<runId>.json`. The run record stays
readable even if the brief file is later edited or deleted. Runs recorded before
brief support have no `task.source` and keep working.

## Workflows

`--workflow` names which participants take part in a run.

| Workflow           | Roles                  | Pipeline                                                                    |
| ------------------ | ---------------------- | --------------------------------------------------------------------------- |
| `single` (default) | worker                 | worker → verification → (bounded correction)                                |
| `review`           | worker, critic         | worker → verification → (bounded correction) → independent read-only critic |
| `quality`          | driver, worker, critic | dynamic Driver loop → final verification → independent read-only critic     |

- `--review` is kept as an alias for `--workflow review`. Contradicting the two
  (`--workflow single --review`) is an error, not a silent winner.
- An unknown workflow is a usage error that lists the available names.
- **Correction is part of every workflow.** It is the same worker responding to
  deterministic feedback, not a separate role, so `--no-correct` is an
  orthogonal modifier rather than a workflow of its own.
- `quality` uses a read-only Driver invocation with structured output. The
  Driver chooses from an explicit worker target pool, can request verification,
  and can accept only after mandatory verification is fresh and green. It
  requires at least one `--verify` command and currently renders in plain mode.

`run.workflow` is recorded in the run JSON so two workflows can be compared on
the same brief:

```bash
conjunction run examples/chessquest/brief.md --workflow single
conjunction run examples/chessquest/brief.md --workflow review
conjunction run examples/chessquest/brief.md --workflow quality --verify "pnpm test"
conjunction status   # both runs, with their workflow and brief
```

Options:

- `--brief <file>` — read the brief from a file (explicit form).
- `--workflow <single|review|quality>` — which participants take part (default:
  `single`).
- `--repo <path>` — any path inside the target git repo (default: cwd).
- `--verify "<cmd> [args...]"` — repeatable deterministic check, run in the
  worktree. Splits on whitespace; quote the whole command, not its arguments.
- `--timeout <minutes>` — agent timeout (default: 10). On timeout the whole
  agent process group is killed.
- `--runtime <id>` — worker runtime (`codex-cli` by default).
- `--model <model>` — worker model, recorded on the worker
  `ExecutionTarget` and mapped by that runtime's adapter.
- `--effort <minimal|low|medium|high|maximum>` — explicit worker reasoning
  effort intent. It is accepted only when the selected runtime declares support.
- `--driver-runtime <id>` / `--driver-model <model>` /
  `--driver-effort <level>` — Driver target for `quality`; defaults to the
  worker target unless set. Driver invocations are always read-only and require
  structured output support.
- `--worker-target <id=runtime>` — repeatable extra worker target for
  `quality`. Without this, the Driver receives one target with id `worker`
  using `--runtime`/`--model`.
- `--critic-runtime <id>` / `--critic-model <model>` /
  `--critic-effort <level>` — independent critic target; defaults to the worker
  target unless set.
- `--observer-runtime <id>` / `--observer-model <model>` /
  `--observer-effort <level>` — optional read-only Observer target. The
  Observer runs after the workflow outcome is fixed, receives bounded
  structured run facts, and is advisory only. It requires runtime support for
  read-only execution and structured output.
- `--cleanup` — attempt to remove the worktree+branch after the run. Removal
  is refused (and the worktree preserved) when it has uncommitted changes.
- `--plain` — force plain text output (no TUI), same as piping/CI behavior.
- `--no-correct` — disable the correction loop (see below).
- `--review` — alias for `--workflow review`: after the final verification passes, run an independent
  READ-ONLY reviewer (a second agent invocation against the same worktree).
  Findings are structured (`critical`/`major`/`minor`/`nit` + path +
  suggestion), advisory only — they never change the exit code and never
  trigger another correction. A reviewer crash is logged as
  `unavailable (advisory)` and the run still completes. Works without
  `--verify`. Plain output prints `✓ Review   2 findings (1 major, 1 nit)`
  plus indented finding lines; the TUI adds a `Review` checklist step and
  renders the top 5 findings in the final box (full findings in the run JSON).

## Correction loop (lot 6)

When at least one `--verify` command is configured and verification fails,
Conjunction sends ONE bounded correction attempt to the same worker in the same
worktree:

1. the failed commands (with bounded stdout/stderr tails) are built into a
   deterministic correction packet — the previous agent transcript is never
   included;
2. the agent runs again with that packet ("fix the failures, don't redo the
   work");
3. verification re-runs. The result is terminal: `completed` or `failed`.
   There is no third attempt, ever.

Both attempts are recorded on the run (`attempts` for compatibility and
`invocations` as the V1 execution model, plus `correction.started` /
`correction.completed` events). Plain output marks the boundary with
`── correction (attempt 2/2) ──`; the TUI adds a `Correction (attempt 2)`
checklist step. `--no-correct` disables the loop; without `--verify` there is
nothing to correct against and no correction happens.

## Quality Driver Workflow

`--workflow quality` is sequential and bounded. The Driver itself is a normal
agent invocation:

- role: `driver`;
- read-only: always true;
- structured output: required;
- target: `--driver-runtime` / `--driver-model`, defaulting to the worker
  target.

The Driver returns one structured decision at a time:

- `delegate` — run one writable worker against an allowed worker target;
- `verify` — run the configured deterministic checks as a non-terminal
  checkpoint;
- `accept` — allowed only when the latest verification is green and fresh after
  the latest writable worker invocation;
- `stop` — fail the run with the Driver's reason.

Retry, target switch, and effort escalation are all represented as another
`delegate` decision. There is no parallelism and no generic workflow DSL. The
V1 caps are deterministic: max 8 Driver decisions and max 4 writable worker
invocations. Driver decisions are stored in `run.driverDecisions[]`; verification
checkpoints are stored in `run.verificationHistory[]`.
Worker target facts sent to the Driver separate runtime support from effective
worker permission:

```json
{
  "runtimeCapabilities": {
    "supportsReadOnly": true,
    "supportsStructuredOutput": true
  },
  "workerPermissions": {
    "workspaceWrite": true
  }
}
```

`supportsReadOnly: true` means the runtime can be restricted for Driver/Critic
invocations. It does not mean the worker target is read-only. `workspaceWrite`
means only that Conjunction permits the worker invocation to modify its isolated
worktree; it does not grant commit rights, host filesystem access, or a broad
terminal/tool policy.
Each writable worker invocation records whether its before/after worktree diff
fingerprint changed. The next Driver packet exposes this as
`lastWorkerChangedWorkspace`, alongside consecutive repeated verification
failure counts, so the Driver can reason about stalls without Conjunction doing
AI-based code quality analysis.

## Interactive TUI

When stdout is a terminal, `run` renders an Ink-based TUI instead of plain
text (pipes, CI and `--plain` get the plain output). The visual style follows
the Daytona CLI: a vertical step checklist, rounded key-value boxes, a
restrained palette (green ✓, red ✗, dim gray for secondary text) and plenty
of breathing room:

```
╭────────────────────────────────────────────╮
│  Task      ChessQuest                      │
│  Brief     examples/chessquest/brief.md    │
│  Workflow  review                          │
│  Run       a1b2c3d4                        │
│  Branch    conjunction/a1b2c3d4            │
│  Worktree  …/.conjunction/worktrees/a1b2…  │
│  Verify    typecheck · test                │
╰────────────────────────────────────────────╯

✓ Workspace ready          conjunction/a1b2c3d4
⠋ Agent (attempt 1)

── agent output ──
…streamed agent stdout; stderr dimmed…

elapsed 01:23 · q / Ctrl-C: cancel · ↑/↓: scroll
```

- Info box: run metadata (task, brief and workflow when set, run, branch,
  worktree, verify commands).
- Checklist: one step per phase — workspace, agent (per attempt),
  verification (per round), correction (only if it happens). Done = green ✓
  with a dim detail (branch, duration), active = spinner, failed = red ✗ with
  the failed command names. Per-command verify results appear indented under
  the verification step.
- Agent output: streamed, auto-following; ↑/↓ (or PageUp/PageDown) scrolls —
  scrolling up pauses follow, scrolling back to the end resumes it. Output is
  capped at a 2,000-line ring buffer (dropped lines counted in the label).
- Final box: big colored COMPLETED / FAILED / CANCELLED state with attempts,
  worktree, verification recap, cleanup outcome and the metadata path.

The plain (non-TTY) output uses the same vocabulary without borders: ✓/✗
checklist lines as steps complete, per-command verify lines as they finish,
and an aligned key-value summary. `conjunction status` and
`conjunction doctor` use the same ✓/✗/■ symbols.

Keys: `q` or `Ctrl-C` cancels the run gracefully at any phase — during the
agent (its process group is killed via the AbortSignal path) as well as during
verification (the running command is killed; the run ends `cancelled`, never
`failed` because you interrupted it). A second Ctrl-C in plain mode
force-exits. `q` / `enter` dismisses the final panel.

Exit codes: `0` = run completed (agent exited cleanly and verification passed,
or no `--verify` was given); `1` = run failed/cancelled; `2` = usage or setup
error (not a git repo, agent runtime unavailable, …).

Every run writes (best-effort: if the directory is not writable the run
continues with a warning and no metadata):

- `.conjunction/runs/<runId>.json` — task + run metadata, including explicit
  agent `invocations`, rewritten at each state change;
- `.conjunction/runs/<runId>.events.jsonl` — the full event stream
  (`task.created`, `run.started`, `workspace.created`, `invocation.created`,
  `invocation.started`, `agent.started`, `agent.output`, `agent.completed`,
  `invocation.completed/failed`, `verification.*`, `correction.*`,
  `review.*`, `run.landed`, `run.completed/failed/cancelled`).

### `conjunction report <runId>`

Builds a run intelligence report from stored Conjunction facts. The report does
not parse raw runtime stdout to invent metrics; unavailable usage is reported as
`unknown` coverage, never as zero.

```bash
conjunction report <runId> --repo /path/to/repo
conjunction report <runId> --repo /path/to/repo --json
```

The JSON report includes:

- outcome state and deterministic verification evidence;
- invocation summaries with role, runtime, model, reasoning effort, parent,
  termination reason and duration;
- actual invocation permissions (`readOnly`, `workspaceWrite`) derived from the
  invocation, not from runtime capabilities;
- usage coverage (`unknown` / `partial` / `complete`), the count of invocations
  that reported structured telemetry, and aggregate metrics (including
  `estimatedCostUsd`) only from those known invocations;
- target switches, effort escalations, correction count and verification
  timings;
- review and Observer summaries when present;
- conservative acceptance coverage: a passing verification is recorded as
  `not_demonstrated` unless there is an explicit acceptance-criteria-to-evidence
  mapping (not implemented in V1).

## Live Eval

`pnpm eval:live` is an explicit, opt-in real-runtime smoke scenario. It is not
part of `pnpm test`.

Run `pnpm build` first, then:

```bash
pnpm eval:live
```

The script creates a disposable Git repository, runs the `quality` workflow
through `dist/cli/main.js`, checks the generated worktree, runs deterministic
verification, generates the same JSON report as `conjunction report`, and then
actually lands the run with `conjunction land` to verify the patch appears
uncommitted in the main tree, `run.landed` is persisted, and a `run.landed`
event is recorded.

Defaults:

- worker: `codex-cli`;
- driver: `claude-code`;
- critic: `claude-code`;
- observer: `claude-code`;
- timeout: `5` minutes;
- max invocations: `8`.

Useful environment overrides:

- `CONJUNCTION_LIVE_WORKER_RUNTIME`, `CONJUNCTION_LIVE_WORKER_MODEL`;
- `CONJUNCTION_LIVE_DRIVER_RUNTIME`, `CONJUNCTION_LIVE_DRIVER_MODEL`;
- `CONJUNCTION_LIVE_CRITIC_RUNTIME`, `CONJUNCTION_LIVE_CRITIC_MODEL`;
- `CONJUNCTION_LIVE_OBSERVER_RUNTIME`, `CONJUNCTION_LIVE_OBSERVER_MODEL`;
- `CONJUNCTION_LIVE_TIMEOUT_MINUTES`;
- `CONJUNCTION_LIVE_MAX_INVOCATIONS`;
- `CONJUNCTION_LIVE_MAX_COST_USD` and `CONJUNCTION_LIVE_MAX_TOKENS`, enforced
  only when the report has reliable usage telemetry;
- `CONJUNCTION_LIVE_KEEP_REPO=1`, to preserve the fixture for inspection.

### `conjunction land <runId>`

Applies a **completed** run's changes onto your current branch as
**uncommitted** working-tree changes (strategy A — atomic patch/apply, see
`docs/land-spec.md`). It never commits, never stages, and never moves your
branch: you review and commit the result yourself.

```bash
conjunction land <runId> [--branch <target>] [--cleanup]
```

What happens, step by step:

1. **Guards** — the run must exist, be `COMPLETED` (not failed/cancelled/
   in-progress), and not already landed. The run's worktree must still exist
   (the changes live there — see _run_ below). Without `--branch`, the target
   is the run's recorded `baseBranch`; a run recorded before landing support
   has no `baseBranch` and requires an explicit `--branch`.
2. **Preflight** — checks the branch checked out at the repo root matches the
   target, and that the target tree is **clean**. A dirty tree is refused with
   each offending file named (no auto-stash — commit or stash first).
   Metdata under `.conjunction/` doesn't count as dirty.
3. **Generate the patch** — inside the run's worktree: `git add -N .` +
   `git diff --binary HEAD`, producing one git-native patch covering new
   files (incl. binaries), edits, renames and deletions. Saved to
   `.conjunction/runs/<runId>.landing.patch`.
4. **`git apply --check`** — if the patch doesn't apply cleanly (e.g. the
   target branch diverged on the same files since the run started),
   **nothing is written** and the conflicting files are reported. The patch is
   preserved for manual handling.
5. **`git apply --binary`** — applies as uncommitted changes in your tree.
6. **Record the landing** — annotates the run JSON with
   `landed { targetBranch, targetCommit, patchPath }` and appends a
   `run.landed` event to the JSONL stream. `run.status` stays `completed`.

```bash
# land the most recent run, identified by its id prefix (see: status)
$ conjunction land bfa1b6a3 --repo /path/to/repo
✓ Preflight passed          main, clean tree
✓ Patch generated           …/.conjunction/runs/<runId>.landing.patch
✓ Applied                   main (uncommitted)

── summary ──
Run:       bfa1b6a3-…
Task:      create a file hello.txt …
Landed:    main @ abc12345 (uncommitted changes)
Patch:     …/.conjunction/runs/<runId>.landing.patch
Rollback:  git apply -R …/.conjunction/runs/<runId>.landing.patch
Cleanup:   worktree preserved (use --cleanup to remove it)
```

Options:

- `--branch <target>` — land onto an explicit branch instead of the recorded
  `baseBranch`; the branch must be checked out at the repo root. **Required**
  for runs recorded before landing support.
- `--cleanup` — after a successful landing, remove the run's worktree and
  branch. This is the one case force-cleanup is justified, because the work is
  now provably present in your tree.

Reference points:

- The landing is **atomic**: if any file conflicts, the whole apply fails and
  your tree is untouched — there is never a silent partial state.
- Rollback is `git apply -R` on the saved patch (safe only if you haven't
  edited those files since).
- Re-landing a run is refused (`already landed`). Landing a run whose worktree
  was cleaned up is refused (nothing to land).
- Reviewer findings are advisory: landing proceeds but prints a warning (with
  a loud note for `critical` findings or a reviewer crash). This is a visible
  note only — review never blocks landing, matching its advisory role.

### `conjunction status`

Lists recorded runs (newest first):

```bash
$ node dist/cli/main.js status --repo /path/to/repo
✓ bfa1b6a3  COMPLETED  codex-cli  2026-08-08T22:07:17.419Z  ChessQuest · 2 findings
   Branch   conjunction/bfa1b6a3-…
   Worktree /path/to/repo/.conjunction/worktrees/bfa1b6a3-…
   Workflow review
   Brief    /path/to/repo/examples/chessquest/brief.md
```

`Workflow` and `Brief` are omitted for runs recorded before this support, and
`Brief` is omitted for inline descriptions.

## A real example

```bash
$ node dist/cli/main.js run "create a file hello.txt containing the text hello conjunction" \
    --repo /tmp/demo-repo --timeout 8
run:      bfa1b6a3-b790-442a-aa1f-ff98116e1fbf
task:     create a file hello.txt containing the text hello conjunction
workflow: single

✓ Workspace ready             conjunction/bfa1b6a3-…
  worktree: /tmp/demo-repo/.conjunction/worktrees/bfa1b6a3-…

── agent output ──
…codex output…
✓ Agent (attempt 1)             12.4s

── summary ──
State:     COMPLETED
Task:      create a file hello.txt containing the text hello conjunction
Workflow:  single
Run:       bfa1b6a3-b790-442a-aa1f-ff98116e1fbf
Attempts:  1
Branch:    conjunction/bfa1b6a3-…
Worktree:  /tmp/demo-repo/.conjunction/worktrees/bfa1b6a3-…
Agent:     finished — final message: Created `hello.txt` …
Verify:    no verification commands configured
Metadata:  /tmp/demo-repo/.conjunction/runs/bfa1b6a3-….json (+ .events.jsonl)
Cleanup:   worktree preserved for inspection (use --cleanup to attempt removal)
```

## Safety notes

- The agent only ever runs inside the run's worktree, sandboxed with
  `workspace-write`; Conjunction never passes `danger-full-access` or
  `--dangerously-bypass-approvals-and-sandbox`.
- The prompt instructs the agent to leave changes uncommitted and never run
  git commands; your current branch is never touched.
- Cleanup goes through the safe path: dirty worktrees are refused unless you
  remove them manually.
- Each run records the branch and commit you had checked out when it started
  (`baseBranch`/`baseCommit`) — the landing target for `conjunction land`.
- Landing (`conjunction land`) never commits or stages: it produces
  uncommitted changes you inspect and commit yourself. It refuses a dirty
  target tree, refuses to land onto a branch you don't have checked out, and
  is atomic (a conflicting patch writes nothing).
