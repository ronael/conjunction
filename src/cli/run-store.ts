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

  /** Load one stored run by full id or unique id prefix; undefined if not found/ambiguous. */
  async get(runIdOrPrefix: string): Promise<StoredRun | undefined> {
    try {
      const raw = await readFile(path.join(this.dir, `${runIdOrPrefix}.json`), "utf8");
      return JSON.parse(raw) as StoredRun;
    } catch {
      // fall through to prefix matching
    }
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return undefined;
    }
    const matches = files.filter(
      (file) => file.endsWith(".json") && file.startsWith(runIdOrPrefix),
    );
    if (matches.length !== 1) {
      return undefined;
    }
    try {
      return JSON.parse(await readFile(path.join(this.dir, matches[0] ?? ""), "utf8")) as StoredRun;
    } catch {
      return undefined;
    }
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
