import path from "node:path";

import { findRepoRoot } from "../workspace/index.js";

import { stateLabel, stateSymbol } from "./format.js";
import { RunStore } from "./run-store.js";

/** Lists runs persisted under `.conjunction/runs/`, newest first. */
export async function statusCommand(
  repoPath: string,
  out: (chunk: string) => void,
): Promise<number> {
  let root: string;
  try {
    root = await findRepoRoot(repoPath);
  } catch {
    root = path.resolve(repoPath);
  }
  const store = new RunStore(path.join(root, ".conjunction", "runs"));
  const stored = await store.list();
  if (stored.length === 0) {
    out("no runs found\n");
    return 0;
  }
  for (const { run, task } of stored) {
    // defensive: metadata written by older versions may lack `attempts`/`review`
    const attemptCount = Array.isArray(run.attempts) ? run.attempts.length : 0;
    const attempts = attemptCount > 1 ? ` (${attemptCount} attempts)` : "";
    const findingCount = run.review?.findings?.length ?? 0;
    const findings = findingCount > 0 ? ` · ${findingCount} findings` : "";
    const landed = run.landed !== undefined ? ` · landed→${run.landed.targetBranch}` : "";
    out(
      `${stateSymbol(run.state)} ${run.id.slice(0, 8)}  ` +
        `${stateLabel(run.state).padEnd(9)}  ${run.runtime}  ${run.createdAt}  ` +
        `${task.title}${attempts}${findings}${landed}\n`,
    );
    if (run.branch !== undefined) {
      out(`   ${"Branch".padEnd(9)}${run.branch}\n`);
      out(`   ${"Worktree".padEnd(9)}${run.workspacePath ?? "-"}\n`);
    }
    // both absent on runs recorded before brief/workflow support
    if (run.workflow !== undefined) {
      out(`   ${"Workflow".padEnd(9)}${run.workflow}\n`);
    }
    if (task.source?.kind === "file") {
      out(`   ${"Brief".padEnd(9)}${task.source.path}\n`);
    }
  }
  return 0;
}
