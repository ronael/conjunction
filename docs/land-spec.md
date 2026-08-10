# Mini-spec: `land` — getting a run's changes onto the user's branch

Status: **specification only — no code in this lot.**
Scope: v1 of `conjunction land <runId>`. Safety bar: never lose or corrupt the
user's work, never leave a silent partial state, simple rollback, honest
conflict reporting.

Behaviors marked ✅ were verified empirically against real git (2.50) in
scratch repos (`/tmp/land-exp-*`, worktree layout identical to what
`src/workspace/worktree.ts` produces).

## 1. Grounding: how runs and worktrees work today

From `src/workspace/worktree.ts`, `src/core/run.ts`, `src/cli/run-command.ts`:

- A run creates branch `conjunction/<runId>` at the repo's current HEAD and a
  worktree at `<repoRoot>/.conjunction/worktrees/<runId>`.
- The agent is instructed (and sandboxed) to leave changes **uncommitted** in
  the worktree. In the normal case `conjunction/<runId>` has **no commits of
  its own** — it points at the run's base commit.
- `getWorktreeDiff(path)` returns `git diff HEAD` (tracked changes, no
  `--binary` today) **plus hand-synthesized new-file sections** for untracked
  files (`ls-files --others --exclude-standard`), binary untracked files
  replaced by a `(binary file, contents omitted)` marker. This is good enough
  for the _reviewer packet_ but is **not** a complete landing artifact (see
  §4.4).
- `removeRunWorkspace` refuses dirty worktrees unless `force: true`; it is
  idempotent and partial-failure tolerant since the consolidation pass.
- The run JSON (`<repoRoot>/.conjunction/runs/<runId>.json`) persists
  `state`, `attempts[]`, `review`, `workspacePath`, `branch`, timestamps.
- **Not recorded today:** the branch the user had checked out when the run
  started, nor the base commit. `startRun` creates the worktree from whatever
  `HEAD` is at that moment, so the information exists at run time but is
  thrown away. **The spec requires adding it** (§2).
- Cleanup of a landed run is currently impossible without `force`, because
  the worktree stays dirty by design (uncommitted changes) — and blindly
  forcing would delete un-landed work. `land` must define exactly when force
  is justified (§7).

## 2. Required additions before any landing exists

These are prerequisites, not strategy-specific:

1. **Record the base.** Extend `Run` with `baseBranch?: string` and
   `baseCommit?: string`, captured in `runTask` right before
   `createRunWorkspace`: `git rev-parse --abbrev-ref HEAD` and
   `git rev-parse HEAD` at the repo root. Runs persisted before this change
   lack the fields — `land` must then require an explicit `--branch` and
   refuse otherwise (§8).
2. **Record the landing.** Extend `Run` with
   `landed?: { landedAt: string; targetBranch: string; targetCommit: string; patchPath: string }`.
   `landed` is a **post-terminal annotation, not a state**: `run.state` stays
   `completed`. One new event type, `run.landed`
   (payload `{ targetBranch, targetCommit, patchPath }`), appended to the
   run's JSONL — the minimal honest record.
3. **Shared preconditions** (all strategies):
   - run JSON exists and is readable; `run.state === "completed"`.
   - run is not already landed (`run.landed === undefined`).
   - the worktree still exists at `run.workspacePath` (landing needs the
     changes, which are not persisted anywhere else today).
   - target branch is `run.baseBranch` (verified with
     `git rev-parse --abbrev-ref HEAD` at repo root) unless the user passes
     `--branch <target>` explicitly. **Never land onto a different branch
     silently.**
   - the changes in the worktree are never deleted before they are safely
     landed: cleanup with `force` only _after_ a verified-successful landing.

## 3. The three strategies — mechanics

### A. patch/apply

In the worktree: `git add -N .` (intent-to-add makes untracked files appear
in diffs), then `git diff --binary HEAD > landing.patch`. On the user's tree
at repo root: `git apply --binary --check landing.patch`, then
`git apply --binary landing.patch`. Result: the run's changes appear as
**uncommitted** changes in the user's working tree (✅ verified: ` M` +
`??` status, no index staging, no commits, no branch movement).

The `add -N` trick is the key enabler: ✅ verified that a single patch then
covers tracked modifications, **new text files, new BINARY files
(`GIT binary patch` sections), deletions and renames** in git-native format,
and applies with byte-identical binary content. (For the reviewer's read-only
packet, today's synthetic sections also apply cleanly — ✅ verified — but
they cannot carry binary content; landing uses the native format instead.)

### B. synthetic commit + cherry-pick

In the worktree: `git add -A && git commit -m "conjunction run <runId>"`
(Conjunction's own synthetic commit on `conjunction/<runId>`). On the user's
branch: `git cherry-pick conjunction/<runId>`. Result: a **new commit** on
the user's branch containing the run's changes (✅ verified, new files
included).

### C. branch merge

Same synthetic commit as B, then `git merge conjunction/<runId>` (possibly
`--no-ff`). Result: the user's branch moves — fast-forward if it hasn't
diverged, merge commit otherwise (✅ both verified).

## 4. Analysis per axis

### 4.1 Safety invariants

|                                                    | A (apply)                       | B (cherry-pick)                                                    | C (merge)                                  |
| -------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| Base branch/commit needed                          | Yes, for guard + patch base     | Yes, same                                                          | Yes, same                                  |
| Mutates user's **history**                         | **No** ✅                       | Yes (new commit)                                                   | Yes (ff or merge commit)                   |
| Mutates user's **worktree**                        | Yes (uncommitted changes)       | Yes (via commit application)                                       | Yes                                        |
| Requires git mutations by Conjunction beyond today | `add -N` in _our_ worktree only | + a commit in our worktree, + cherry-pick on the **user's** branch | + commit, + merge on the **user's** branch |

All three need the §2.3 preconditions. A is the only strategy whose
user-visible mutation is exactly "uncommitted changes you can inspect with
`git status`/`git diff` and commit yourself" — the same trust model the MVP
already sells. B and C write to the user's history, which today's Git-safety
contract (AGENTS.md, docs/architecture-review.md) deliberately avoids:
_never merges, never pushes, never `reset --hard` on the user's branch._

### 4.2 Conflict handling (target diverged since run start)

- **A:** `git apply` is **fully atomic** — ✅ verified with a mixed patch
  (one applicable file + one failing file): _nothing_ is written, and stderr
  names each failing file (`error: patch failed: f.txt:1`). UX: a clean
  refusal plus a precise conflict file list. No 3-way fallback:
  `git apply --3way` was verified unreliable for our inputs (fails against a
  dirty/mismatched index; synthetic sections lack blob ids), so v1 does not
  use it. User remedy: resolve by hand in their tree, or re-run the task.
- **B:** `git cherry-pick` stops in a `CHERRY_PICKING` state with conflict
  markers in the diverged files **and the non-conflicting files already
  staged** (✅ verified: `UU f.txt`, `A new.txt`). That _is_ a partial state:
  the repo is mid-operation and the user must know how to
  `--continue`/`--abort`. Conjunction would have to either leave that state
  (poor "never leave a mess" UX) or run `cherry-pick --abort`, which
  ✅ verified restores everything — but then _nothing_ landed, same as A's
  refusal, with more machinery.
- **C:** merge conflicts behave identically to B (`MERGING` state, staged
  non-conflicting files, `merge --abort` restores ✅). Same partial-state
  problem, plus a merge commit if the user resolves it — more history noise.

For v1's honesty bar, A's "nothing happened, here is the exact conflict
list" is strictly better than "your repo is now in a merge state, good luck".

### 4.3 Dirty working tree (user has uncommitted changes)

- **A:** `git apply` fails **only on overlapping files** — ✅ verified:
  dirty unrelated file + patch elsewhere applies; dirty file targeted by the
  patch → atomic rejection. This is exactly protective.
- **B/C:** both **refuse outright** when the merge would touch dirty files
  (✅ verified: "Your local changes … would be overwritten by merge.
  Aborting"), and can silently _succeed_ over dirty-but-unrelated trees —
  mingling the user's uncommitted work with a new commit.

**v1 policy (all strategies, but only A is chosen): refuse to land onto a
dirty target tree.** `git status --porcelain` at repo root must be empty
(ignoring `.conjunction/`). No auto-stash: `git stash -u` round-trips fine
(✅ verified, and it skips nested worktrees), but auto-stashing the user's
work adds a failure mode (stash pop conflicts, forgotten stashes) for zero
safety gain. Refusal + a clear message ("commit or stash your changes first")
is the honest behavior.

### 4.4 Untracked / binary / renames / deletions

- **A with `add -N` + `--binary`:** ✅ verified full coverage — new text
  files, new binary files (byte-identical), deletions (` D` applied),
  renames (rename patches apply; old gone, new present). Today's _review_
  diff format (synthetic sections, no `--binary`) is **not** sufficient for
  landing: binary _modifications_ are rejected without full binary patches
  (✅ verified: "cannot apply binary patch … without full index line"), and
  untracked binaries are omitted entirely. Landing must generate its own
  `git diff --binary HEAD` after `add -N`, not reuse `getWorktreeDiff` (which
  stays as-is for the reviewer).
- **B/C:** native commits cover everything by construction, including
  binaries. Equal to A here.
- Edge note: `add -N` leaves ` A` (intent-to-add) entries in the worktree
  index — harmless: the worktree remains "dirty" for cleanup purposes, and
  `removeRunWorkspace` is unaffected.

### 4.5 Rollback

What must be recorded _before_ attempting: target branch name, target HEAD
sha, and the exact patch (`landing.patch` persisted to
`.conjunction/runs/<runId>.landing.patch`).

- **A:** failure happens _before_ anything is written (atomic), so there is
  nothing to roll back — the ideal case. After a successful apply, an
  immediate `git apply -R landing.patch` reverses it exactly (✅ verified:
  tree restored byte-for-byte) and never touches history. The saved patch
  also lets the _user_ reverse manually later, as long as they haven't
  edited those files since.
- **B:** mid-conflict, `cherry-pick --abort` restores (✅). After a
  _successful_ cherry-pick, undoing means `git reset --hard HEAD~1` —
  **forbidden** by our own Git-safety rules on the user's branch.
- **C:** same as B, with the extra wrinkle that a fast-forward merge also
  requires `reset --hard` to undo.

A is the only strategy whose post-success rollback stays inside the rules
Conjunction set for itself.

### 4.6 Idempotence

- **A:** re-applying the same patch fails loudly ("already exists in working
  directory" / "patch does not apply") — not silently harmful, but v1 guards
  anyway: `run.landed !== undefined` → refuse with "already landed". Landing
  a run whose worktree was cleaned up → refuse (no changes to land).
  Landing after the base branch moved → apply context may fail; the
  `--check` step catches it and reports conflicting files.
- **B:** second cherry-pick errors with "previous cherry-pick is now empty"
  or creates a duplicate commit — worse than A's guard.
- **C:** second merge prints "Already up to date." and exits 0 — _silently
  fine_, but only because the branch was never cleaned; combined with branch
  deletion after landing, the merge target may not even exist (`error:
conjunction/<id> is not a commit`). Requires the same guards as A on top.

## 5. Comparison summary

| Axis                                      | A. patch/apply                  | B. cherry-pick                    | C. merge               |
| ----------------------------------------- | ------------------------------- | --------------------------------- | ---------------------- |
| User history untouched                    | ✅                              | ✗ new commit                      | ✗ ff/merge commit      |
| Atomic, no partial states                 | ✅                              | ✗ CHERRY_PICKING state            | ✗ MERGING state        |
| Conflict UX                               | Clean refusal + file list       | Conflict markers + staged partial | Same as B              |
| Post-success rollback within safety rules | ✅ `apply -R`                   | ✗ needs `reset --hard`            | ✗ needs `reset --hard` |
| New/binary/rename/delete coverage         | ✅ (with `add -N` + `--binary`) | ✅                                | ✅                     |
| Dirty-tree policy                         | refuse (v1)                     | refuse (v1)                       | refuse (v1)            |
| New git mutations for Conjunction         | `add -N` in own worktree        | + commit, + cherry-pick           | + commit, + merge      |
| Double-land behavior                      | loud failure + guard            | empty/dup commit                  | silent no-op           |

## 6. Decision: **strategy A — patch/apply**

A is the only strategy that satisfies all four v1 optimization goals at once.
It never loses work (atomic apply — verified that a mixed patch writes
nothing when any file conflicts), it never leaves a silent partial state (no
CHERRY_PICKING/MERGING limbo, no staged leftovers), rollback is exact and
_permitted_ (`git apply -R` on a saved patch, vs the `reset --hard` that B
and C would require and that Conjunction's own Git-safety contract forbids
on the user's branch), and conflict reporting is honest and precise
(per-file `patch failed` lines). It also matches the product's existing
trust model: the run's work appears as uncommitted changes the human reviews
and commits themselves — Conjunction still never writes to the user's
history. With `git add -N` + `git diff --binary HEAD`, A covers new files
(including binaries), renames and deletions with git-native fidelity, so the
usual "apply can't do untracked" objection does not apply.

## 7. Architecture and flow

- **New leaf module `src/workspace/land.ts`** (git operations only, same
  style as `worktree.ts`): `buildLandingPatch(worktreePath)` (`add -N .` +
  `diff --binary HEAD`), `applyLandingPatch(repoRoot, patchFile, { check })`,
  `readCurrentBranch(repoRoot)`. Never a shell; typed errors with git stderr
  attached.
- **New `src/cli/land-command.ts`** (composition): loads the run via
  `RunStore`, enforces §2.3 preconditions, calls the leaf, persists
  `run.landed` + the `run.landed` event, saves the patch to
  `.conjunction/runs/<runId>.landing.patch`. **No orchestrator changes** —
  landing is a separate command over persisted state; core gains only the
  optional `Run` fields (`baseBranch`, `baseCommit`, `landed`) and the one
  event type.
- **Command shape:** `conjunction land <runId> [--branch <target>] [--cleanup]`.
  Flow: guards → `buildLandingPatch` → `apply --check` (report conflicting
  files on failure, exit 1, nothing written) → `apply` → record landing →
  optional cleanup.
- **Cleanup after landing:** `--cleanup` calls `removeRunWorkspace` with
  `force: true` — the _only_ situation where force is justified without the
  user asking, because the work is now provably present in the user's tree
  (applied patch + recorded target sha). Without `--cleanup`, the worktree is
  preserved exactly as today (still dirty, still refused by plain cleanup).

## 8. Explicit v1 exclusions

- **No landing of non-completed runs** (failed/cancelled/in-progress:
  refused).
- **No landing onto a dirty target tree** — refuse, name the dirty files,
  no auto-stash.
- **No conflict resolution assistance** — no `--3way`, no conflict markers,
  no "accept theirs/ours". Report conflicting files; the user resolves.
- **No commits on the user's branch** — landing produces uncommitted
  changes; the user commits. No staging either (`git apply`, not
  `git apply --index`).
- **No synthetic commits** in the worktree (only `add -N`, which is
  index-local to our own worktree).
- **No auto-land** on `conjunction run` success — landing stays a separate,
  deliberate command with its human-inspection step.
- **No landing without the worktree** — if it was cleaned up, refuse
  (regenerating diffs from event streams is out of scope).
- **No landing onto a branch other than `run.baseBranch`** without explicit
  `--branch`; runs persisted before `baseBranch` existed require `--branch`.
- **No re-land** — `run.landed` guard; no "force re-apply" flag.

## 9. Open questions

1. Should a successful `--cleanup` after landing also be the default when
   `land` succeeds (i.e. opt-out `--keep` instead of opt-in `--cleanup`)?
   v1 keeps the current preserve-by-default posture.
2. Should `run` gain a `--land` convenience flag later (land automatically on
   success)? Deferred — it weakens the inspection step.
3. Reviewer-errored runs are `completed` and thus landable. Acceptable
   (review is advisory), but should `land` print a louder note when
   `run.review.error` or unresolved `critical` findings exist?
