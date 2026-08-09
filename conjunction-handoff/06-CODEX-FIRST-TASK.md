# First Codex Task

Use the following as the first implementation prompt after these documents are available in the repository.

---

You are bootstrapping Conjunction, an open-source orchestration runtime for coding agents.

First, read:

- `00-START-HERE.md`
- `01-VISION.md`
- `02-REFERENCE-PROJECTS.md`
- `03-ARCHITECTURE.md`
- `04-MVP-ROADMAP.md`
- `05-DECISIONS.md`
- `AGENTS.md`

Then inspect the current repository.

Before writing code, do a focused architecture review:

1. Identify assumptions in the proposed architecture that should be changed before implementation.
2. Compare the relevant ideas with the listed reference projects.
3. Keep Conjunction substantially smaller than those systems at this stage.
4. Decide whether the initial bootstrap should be a pnpm TypeScript workspace or a single package with extractable internal modules.
5. Propose concrete lots for Lots 0–3 only:
   - repository/tooling;
   - core task/run/event model;
   - safe Git/worktree workspace;
   - deterministic verification.
6. Explicitly list what you will *not* implement yet.

After producing that plan, implement Lots 0–3.

Requirements:

- TypeScript strictness.
- Clean boundaries.
- No fake AI/provider layer pretending to work.
- No multi-agent swarm.
- No UI.
- No database unless you can demonstrate it is necessary for Lots 0–3.
- Tests for state transitions and Git/worktree operations.
- Git safety must be deliberate and documented.
- Establish canonical typecheck, lint, test and build commands.
- Update `AGENTS.md` with the final canonical validation commands.
- Update architecture docs if implementation reality differs from the proposal.

At the end, report:

- architecture chosen and why;
- files/packages created;
- checks run and their exact results;
- known limitations;
- recommended Lot 4 adapter contract, without implementing Lot 4 unless requested.
