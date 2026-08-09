# Using the Conjunction CLI

Build first, then use the `conjunction` bin (or call node directly):

```bash
pnpm install
pnpm build
node dist/cli/main.js --help        # or link the bin: pnpm link --global
```

Requires: node >= 20, git, and the [Codex CLI](https://github.com/openai/codex)
installed and authenticated (`codex --version` should work).

## Commands

### `conjunction doctor`

Checks that the agent runtime is installed and usable:

```bash
$ node dist/cli/main.js doctor
agent runtime "codex-cli": available (codex-cli 0.144.1)
```

### `conjunction run "<task>"`

Executes one task end-to-end:

1. builds a `Task` from the description;
2. creates branch `conjunction/<runId>` and a worktree at
   `<repoRoot>/.conjunction/worktrees/<runId>`;
3. runs the codex agent sandboxed (`workspace-write`) inside the worktree,
   streaming its output;
4. runs each `--verify` command (sequentially, fail-fast) inside the worktree;
5. prints a summary and preserves the worktree for inspection.

```bash
conjunction run "create a file hello.txt containing the text hello conjunction" \
  --repo /path/to/repo \
  --verify "pnpm exec tsc --noEmit" \
  --verify "pnpm test" \
  --timeout 10
```

Options:

- `--repo <path>` — any path inside the target git repo (default: cwd).
- `--verify "<cmd> [args...]"` — repeatable deterministic check, run in the
  worktree. Splits on whitespace; quote the whole command, not its arguments.
- `--timeout <minutes>` — agent timeout (default: 10). On timeout the whole
  agent process group is killed.
- `--model <model>` — passed through as `codex exec -m <model>`.
- `--cleanup` — attempt to remove the worktree+branch after the run. Removal
  is refused (and the worktree preserved) when it has uncommitted changes.
- `--plain` — force plain text output (no TUI), same as piping/CI behavior.
- `--no-correct` — disable the correction loop (see below).
- `--review` — after the final verification passes, run an independent
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

Both attempts are recorded on the run (`attempts` in the run JSON, plus
`correction.started` / `correction.completed` events). Plain output marks the
boundary with `── correction (attempt 2/2) ──`; the TUI adds a
`Correction (attempt 2)` checklist step. `--no-correct` disables the loop;
without `--verify` there is nothing to correct against and no correction
happens.

## Interactive TUI

When stdout is a terminal, `run` renders an Ink-based TUI instead of plain
text (pipes, CI and `--plain` get the plain output). The visual style follows
the Daytona CLI: a vertical step checklist, rounded key-value boxes, a
restrained palette (green ✓, red ✗, dim gray for secondary text) and plenty
of breathing room:

```
╭────────────────────────────────────────────╮
│  Task      add a dark-mode toggle          │
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

- Info box: run metadata (task, run, branch, worktree, verify commands).
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

- `.conjunction/runs/<runId>.json` — task + run metadata, rewritten at each
  state change;
- `.conjunction/runs/<runId>.events.jsonl` — the full event stream
  (`task.created`, `run.started`, `workspace.created`, `agent.started`,
  `agent.output`, `agent.completed`, `verification.*`, `correction.*`,
  `review.*`, `run.completed/failed/cancelled`).

### `conjunction status`

Lists recorded runs (newest first):

```bash
$ node dist/cli/main.js status --repo /path/to/repo
✓ bfa1b6a3  COMPLETED  codex-cli  2026-08-08T22:07:17.419Z  create a file hello.txt …
   Branch   conjunction/bfa1b6a3-…
   Worktree /path/to/repo/.conjunction/worktrees/bfa1b6a3-…
```

## A real example

```bash
$ node dist/cli/main.js run "create a file hello.txt containing the text hello conjunction" \
    --repo /tmp/demo-repo --timeout 8
run:    bfa1b6a3-b790-442a-aa1f-ff98116e1fbf
task:   create a file hello.txt containing the text hello conjunction

✓ Workspace ready             conjunction/bfa1b6a3-…
  worktree: /tmp/demo-repo/.conjunction/worktrees/bfa1b6a3-…

── agent output ──
…codex output…
✓ Agent (attempt 1)             12.4s

── summary ──
State:     COMPLETED
Task:      create a file hello.txt containing the text hello conjunction
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
