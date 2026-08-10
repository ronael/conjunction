# Discovering & testing Conjunction

This guide assumes you are **discovering the project for the first time**. It
explains what Conjunction is, how to install and build it, what each part does,
how to run it for real, and how to exercise every feature — with copy/paste
examples. There is no prior knowledge of the code assumed.

If you just want the reference for the CLI flags, read `docs/usage.md`
instead. This document is the "learn by doing" companion.

---

## 1. What is Conjunction?

Conjunction is a **single-command orchestration runtime for coding agents**.

Today it drives OpenAI's **Codex CLI** to do a task in complete isolation, then
lets you review and bring the result back to your own branch. Its core promise:

> **The agent never touches your branch.** It works in a throwaway git worktree
> on a local branch. When you're happy with the result, you land it back onto
> your branch yourself with one command.

The three big behaviors it provides today:

1. **`run`** — describe a task in plain language; Conjunction isolates the
   agent in a git worktree, runs it, verifies the result, optionally reviews
   it, and records everything.
2. **`land`** — take a completed run's changes and apply them onto your branch
   as **uncommitted** changes you can inspect and commit yourself.
3. **`status` / `doctor`** — inspect what ran, and check the environment.

The project is deliberately **minimal and safe**: no database, no server, no
network calls beyond the agent runtime itself. Everything is files under a
`.conjunction/` folder in the repo you're working on. There is no speculative
multi-agent orchestration — the single-agent loop comes first.

---

## 2. What you need to install

- **Node.js >= 20**
- **git** (the whole design is built on git worktrees)
- **The Codex CLI** — `codex exec` must work:
  ```bash
  codex --version
  ```
  (Conjunction shells out to `codex exec`; the agent is codex itself.)

Verifying all of this is done by Conjunction automatically:

```bash
node dist/cli/main.js doctor
# agent runtime "codex-cli": available (codex-cli 0.x.x)
```

---

## 3. Installing & building the project

```bash
# from the repository root
pnpm install      # install dependencies
pnpm build        # compile TypeScript to dist/
```

You now have a CLI at `dist/cli/main.js`.

Two ways to run it:

```bash
# direct
node dist/cli/main.js --help

# or link it globally so `conjunction` just works
pnpm link --global
conjunction --help
```

The `--help` output is your map of the whole tool:

```
conjunction — orchestration runtime for coding agents

usage:
  conjunction run "<task>" [--repo <path>] [--verify "<cmd> [args...]"]...
                           [--timeout <minutes>] [--model <model>] [--cleanup]
                           [--plain] [--no-correct] [--review]
  conjunction land <runId> [--repo <path>] [--branch <target>] [--cleanup]
  conjunction status [--repo <path>]
  conjunction doctor
```

---

## 4. A first real run, end to end

Let's actually use it. Create a throwaway git repo, then run a task.

```bash
# 1. make a scratch repo
mkdir -p /tmp/demo-repo && cd /tmp/demo-repo
git init -b main
git config user.email you@example.com
git config user.name "You"
echo "# Demo" > README.md
git add README.md && git commit -m "init"

# 2. run a task that creates a file
cd /Users/ronaeldat/Workspace_perso/conjunction   # wherever you built it
node dist/cli/main.js run "create a file hello.txt containing the text hello conjunction" \
  --repo /tmp/demo-repo --timeout 8
```

Watch the output. You'll see Conjunction:

1. print a run id (a UUID) and the task;
2. create branch `conjunction/<runId>` and a worktree;
3. stream the codex agent's output (attempt 1);
4. print a summary.

When it finishes, look at what happened on disk:

```bash
# the run's own branch exists
cd /tmp/demo-repo
git branch --list 'conjunction/*'

# the worktree with the agent's changes lives here
ls -la .conjunction/worktrees/*/hello.txt

# your main branch was NOT touched
git status            # clean!
git log --oneline -1  # still your "init" commit
```

Inspect the agent's work before deciding anything:

```bash
cd .conjunction/worktrees/*/
git status            # hello.txt is UNTRACKED (agent leaves changes uncommitted)
cat hello.txt         # "hello conjunction"
```

> Key mental model: **the run's work lives in the worktree, not on your
> branch.** Your branch is untouched by design.

---

## 5. Landing the result back onto your branch

Now bring the changes home with `land`. It applies the worktree's changes onto
your current branch as **uncommitted** changes.

```bash
cd /tmp/demo-repo
git checkout main

# find the run id (or use its first 8 chars)
node dist/cli/main.js status --repo /tmp/demo-repo

# land it — the run id with just its prefix
node dist/cli/main.js land bfa1b6a3 --repo /tmp/demo-repo
```

Expected output:

```
✓ Preflight passed          main, clean tree
✓ Patch generated           …/.conjunction/runs/<runId>.landing.patch
✓ Applied                   main (uncommitted)
```

Now on your branch:

```bash
git status        # hello.txt shows as UNTRACKED — a real change, not staged
cat hello.txt     # "hello conjunction" is in your working tree
```

**Nothing was committed.** That's the point: you review, then you commit:

```bash
git add hello.txt && git commit -m "add hello.txt from conjunction run"
```

If you ever want to undo a landing before committing (and you haven't edited
those files since), roll it back with the saved patch:

```bash
git apply -R .conjunction/runs/<runId>.landing.patch
```

---

## 6. Adding verification (`--verify`)

`--verify` runs **deterministic checks** in the worktree after the agent
finishes. This is how you get "the agent's work is actually correct", not just
"the agent exited 0".

```bash
node dist/cli/main.js run \
  "add a function sum(a,b) to math.ts and export it" \
  --repo /tmp/demo-repo \
  --verify "pnpm exec tsc --noEmit" \
  --verify "pnpm test" \
  --timeout 10
```

For a tiny self-contained example without a real build, verify against any
command:

```bash
node dist/cli/main.js run "create a file greeting.txt containing the word hello" \
  --repo /tmp/demo-repo \
  --verify "test I found hello"  # dummy, see note below
```

> **Note on `--verify`:** Conjunction splits the string on whitespace and runs
> the first token as the command with the rest as args. Quote the _whole_
> command, not its arguments. It does **not** run through a shell, so pipes and
> `&&` won't work. Use it for real commands like `pnpm exec tsc --noEmit`,
> `npm test`, `pytest tests`, etc.

---

## 7. The correction loop (when verification fails)

If at least one `--verify` is configured and it **fails**, Conjunction sends
**exactly one** bounded correction attempt to the same agent in the same
worktree, with a packet describing the failures (tails of the failed command
output — _not_ the agent's past transcript). Then it re-verifies. The result
is terminal: `completed` or `failed`. There is **no third attempt, ever**.

- `--no-correct` disables the loop.
- Without `--verify` there's nothing to verify, so no correction happens.

Try it with a task that will fail verification:

```bash
node dist/cli/main.js run "create file bug.js (it can be empty)" \
  --repo /tmp/demo-repo \
  --verify "test -f does-not-exist.js"
```

You'll see `── correction (attempt 2/2) ──` in the output, then the terminal
state.

---

## 8. The reviewer (`--review`)

`--review` runs an **independent, read-only** second agent invocation against
the same worktree after verification passes. It produces structured findings
(`critical` / `major` / `minor` / `nit` + file path + suggestion).

Findings are **advisory only** — they never change the exit code and never
trigger another correction. If the reviewer crashes, the run still completes
(`unavailable (advisory)`).

```bash
node dist/cli/main.js run "write a well-documented add.ts" \
  --repo /tmp/demo-repo \
  --review
```

Landing a reviewed run proceeds even with findings, but prints a warning (a
louder one for `critical` findings or a reviewer crash) — review informs, it
doesn't block.

---

## 9. The interactive TUI

When stdout is a real terminal, `run` renders an Ink-based **TUI**: a vertical
step checklist, an info box, streamed agent output, and a final status panel.

```bash
node dist/cli/main.js run "create a file hi.txt" --repo /tmp/demo-repo
```

- `q` / `Ctrl-C` cancels the run gracefully at any phase.
- `↑` / `↓` scrolls the agent output (scrolling up pauses auto-follow).
- A second `Ctrl-C` force-exits.

Pipes, CI, and `--plain` all get the plain text output instead.

---

## 10. What's stored on disk (understanding `.conjunction/`)

Every run writes into `<repoRoot>/.conjunction/`:

```
.conjunction/
├── runs/
│   ├── <runId>.json            # task + run metadata (state, attempts, review,
│   │                           #   baseBranch, baseCommit, landed, ...)
│   ├── <runId>.events.jsonl    # the full event stream
│   └── <runId>.landing.patch   # saved by `land` (used for apply/rollback)
└── worktrees/
    └── <runId>/                # the isolated worktree where the agent ran
```

Inspect a run's JSON to see everything recorded:

```bash
cat .conjunction/runs/<runId>.json | python3 -m json.tool
```

Notable fields: `state` (`running` → `completed`/`failed`/`cancelled`),
`baseBranch`/`baseCommit` (the target you had checked out at run start),
`landed` (set after a successful `land`), `attempts[]`, `review`.

The JSONL file is an append-only timeline of events: `task.created`,
`run.started`, `workspace.created`, `agent.started`, `agent.output`,
`agent.completed`, `verification.*`, `correction.*`, `review.*`,
`run.landed`, `run.completed/failed/cancelled`.

---

## 11. Border cases — what `land` refuses (and why)

These are deliberate safety guards. Try each; Conjunction should refuse with a
clear message and _write nothing_:

```bash
# clean the scratch repo, re-run a task first
cd /tmp/demo-repo && git clean -fd && git checkout main
node dist/cli/main.js run "create a file note.txt" --repo /tmp/demo-repo

# 1) refuse to land twice
node dist/cli/main.js land <runId> --repo /tmp/demo-repo    # lands, ok
node dist/cli/main.js land <runId> --repo /tmp/demo-repo    # "already landed"

# 2) refuse a dirty target tree (you have uncommitted changes)
git checkout main && echo "dirty" >> README.md
node dist/cli/main.js land <runId> --repo /tmp/demo-repo    # refused, names README.md
git checkout .                                              # undo

# 3) refuse a wrong checked-out branch
git checkout -b feature
node dist/cli/main.js land <runId> --repo /tmp/demo-repo    # "wrong branch checked out"
git checkout main

# 4) refuse a run whose worktree was cleaned up
node dist/cli/main.js land <runId> --repo /tmp/demo-repo --cleanup  # lands + removes
node dist/cli/main.js land <runId> --repo /tmp/demo-repo            # "worktree is gone"

# 5) refuse a non-completed run (e.g. one you cancelled)
node dist/cli/main.js run "create x" --repo /tmp/demo-repo   # cancel with Ctrl-C
node dist/cli/main.js land <runId> --repo /tmp/demo-repo     # "only completed runs"
```

**On a conflict** (the target branch diverged on a file the patch touches
since the run started), `land` is **atomic**: nothing is written, the patch is
preserved for manual handling, and you fix conflicts by hand then apply with
`git apply --binary <patch>`.

---

## 12. Running the automated test suite

The repo mirrors `src/` under `tests/` with Vitest.

```bash
# the canonical validation commands (run ALL before considering a change done)
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint . && prettier --check .
pnpm test        # vitest run
pnpm build       # tsc -p tsconfig.build.json
```

`pnpm test` currently runs **242 tests across 16 files**, including extensive
coverage of `land` (patch generation across text/binary/delete cases, atomic
conflict handling, preflight guards) and the full CLI. Notably, adapter tests
**fake** the process spawner — they never invoke a real agent runtime.

---

## 13. Cleaning up

- Remove a specific run's worktree and branch after a successful `land`:
  ```bash
  node dist/cli/main.js land <runId> --repo /tmp/demo-repo --cleanup
  ```
- The run metadata (`runs/*.json`, `*.events.jsonl`, `*.landing.patch`) is just
  files; delete them under `.conjunction/runs/` when you no longer need them.
- To fully reset a scratch repo: `git clean -fd` + delete `.conjunction/`.

---

## 14. If something seems wrong

1. **`doctor`** — confirms the agent runtime is available.
2. **The JSON/JSONL** — every run records its full event timeline; that's where
   to look for what the agent did and what the verification/reviewer said.
3. **`status`** — a quick list of runs and their states.
4. New runs only record `baseBranch`/`baseCommit` from this feature onward; a
   run recorded before that has no `baseBranch` and `land` will ask for an
   explicit `--branch`.

---

## 15. The codebase at a glance (for when you dig in)

```
src/
├── cli/              composition root: wires everything, owns run persistence
│   ├── cli.ts        argument parsing + command dispatch
│   ├── run-command.ts    the `run` flow
│   ├── land-command.ts   the `land` flow (guards → patch → check → apply → record)
│   ├── status-command.ts `status`
│   ├── run-store.ts      reads/writes .conjunction/runs/*.json + .jsonl
│   └── ui/               the Ink TUI (dynamic-imported, leaf consumer)
├── core/             the engine: task/run/event model, orchestrator, agent port
│   ├── orchestrator.ts   defines WorkspaceProvider / VerificationRunner ports
│   ├── agent.ts          defines the AgentAdapter port
│   ├── run.ts / task.ts  the data model (Run, Task, attempts, landed, ...)
│   └── events.ts         the event types (incl. run.landed)
├── workspace/        leaf module: git operations only (worktree + land)
│   ├── worktree.ts     create/remove isolated worktrees
│   ├── land.ts         buildLandingPatch / checkPatchApplies / applyPatch
│   └── git.ts          execGit and helpers
├── adapters/codex/   leaf module: the AgentAdapter implementation for Codex CLI
└── verification/     leaf module: the deterministic verification engine
```

Architectural rules worth knowing (see `AGENTS.md` and
`docs/architecture-review.md`):

- `src/workspace/` and `src/verification/` are **leaf modules** — they never
  import from `src/core/`.
- `src/core/` talks to them **only through ports** (`WorkspaceProvider`,
  `VerificationRunner`, `AgentAdapter`). Core never imports a concrete adapter.
- `src/adapters/` and `src/cli/ui/` are leaves; only `src/cli/` wires things
  together.
- Conjunction's git-safety contract forbids automated merges, pushes, branch
  deletion (outside `conjunction/`), and `reset --hard`. `land` is built to
  respect this — it's why it applies a patch (rollback via `git apply -R`)
  instead of cherry-picking or merging.
