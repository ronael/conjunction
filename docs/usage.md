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

Exit codes: `0` = run completed (agent exited cleanly and verification passed,
or no `--verify` was given); `1` = run failed/cancelled; `2` = usage or setup
error (not a git repo, agent runtime unavailable, …).

Every run writes:

- `.conjunction/runs/<runId>.json` — task + run metadata, rewritten at each
  state change;
- `.conjunction/runs/<runId>.events.jsonl` — the full event stream
  (`task.created`, `run.started`, `workspace.created`, `agent.started`,
  `agent.output`, `agent.completed`, `verification.*`, `run.completed/…`).

### `conjunction status`

Lists recorded runs (newest first):

```bash
$ node dist/cli/main.js status --repo /path/to/repo
bfa1b6a3-…  completed  codex-cli  2026-08-08T22:07:17.419Z  create a file hello.txt …
  branch: conjunction/bfa1b6a3-…  worktree: /path/to/repo/.conjunction/worktrees/bfa1b6a3-…
```

## A real example

```bash
$ node dist/cli/main.js run "create a file hello.txt containing the text hello conjunction" \
    --repo /tmp/demo-repo --timeout 8
run:    bfa1b6a3-b790-442a-aa1f-ff98116e1fbf
task:   create a file hello.txt containing the text hello conjunction
branch: conjunction/bfa1b6a3-b790-442a-aa1f-ff98116e1fbf
worktree: /tmp/demo-repo/.conjunction/worktrees/bfa1b6a3-…

--- agent output ---
…codex output…

--- summary ---
state:    completed
agent:    finished — final message: Created `hello.txt` …
verify:   no verification commands configured (vacuous pass)
metadata: /tmp/demo-repo/.conjunction/runs/bfa1b6a3-….json (+ .events.jsonl)
cleanup:  worktree preserved for inspection (use --cleanup to attempt removal)
```

## Safety notes

- The agent only ever runs inside the run's worktree, sandboxed with
  `workspace-write`; Conjunction never passes `danger-full-access` or
  `--dangerously-bypass-approvals-and-sandbox`.
- The prompt instructs the agent to leave changes uncommitted and never run
  git commands; your current branch is never touched.
- Cleanup goes through the safe path: dirty worktrees are refused unless you
  remove them manually.
