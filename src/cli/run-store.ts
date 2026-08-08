import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConjunctionEvent, Run, Task } from "../core/index.js";

export interface StoredRun {
  run: Run;
  task: Task;
}

/**
 * Dead-simple run persistence: one JSON file per run plus one JSONL event
 * log per run, under `<repoRoot>/.conjunction/runs/`. No database, no index —
 * the CLI rewrites the run file at each state change and appends events.
 */
export class RunStore {
  constructor(readonly dir: string) {}

  async save(stored: StoredRun): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      path.join(this.dir, `${stored.run.id}.json`),
      JSON.stringify(stored, null, 2) + "\n",
      "utf8",
    );
  }

  async appendEvents(runId: string, events: readonly ConjunctionEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      path.join(this.dir, `${runId}.events.jsonl`),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  /** All stored runs, newest first. Corrupt files are skipped. */
  async list(): Promise<StoredRun[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const stored: StoredRun[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        stored.push(JSON.parse(await readFile(path.join(this.dir, file), "utf8")) as StoredRun);
      } catch {
        // skip unreadable/corrupt entries rather than failing the whole listing
      }
    }
    return stored.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  }
}
