import path from "node:path";

import { buildRunReport, formatRunReport } from "../core/index.js";
import { findRepoRoot } from "../workspace/index.js";

import { RunStore } from "./run-store.js";

export interface ReportCommandOptions {
  runId: string;
  repoPath: string;
  json: boolean;
}

export async function reportCommand(
  options: ReportCommandOptions,
  deps: { out: (chunk: string) => void },
): Promise<number> {
  let repoRoot: string;
  try {
    repoRoot = await findRepoRoot(options.repoPath);
  } catch {
    deps.out(`error: not a git repository: ${options.repoPath}\n`);
    return 2;
  }
  const store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
  const stored = await store.get(options.runId);
  if (stored === undefined) {
    deps.out(`error: run not found: ${options.runId}\n`);
    return 2;
  }
  const events = await store.events(stored.run.id);
  const report = buildRunReport({ run: stored.run, task: stored.task, events });
  deps.out(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatRunReport(report));
  return 0;
}
