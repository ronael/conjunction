import path from "node:path";

import { findRepoRoot } from "../workspace/index.js";

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
    out(`${run.id}  ${run.state.padEnd(9)}  ${run.runtime}  ${run.createdAt}  ${task.title}\n`);
    if (run.branch !== undefined) {
      out(`  branch: ${run.branch}  worktree: ${run.workspacePath ?? "-"}\n`);
    }
  }
  return 0;
}
