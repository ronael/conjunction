import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/**
 * Narrow view of a spawned child process — the single seam adapter tests fake.
 * `child_process.spawn` (with piped stdio) satisfies this structurally.
 */
export interface SpawnedProcess extends EventEmitter {
  readonly pid?: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  cwd: string;
  /** Spawn as process-group leader so timeout/abort can signal descendants. */
  detached: boolean;
}

export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

/** The real spawner. Never uses a shell; args are passed verbatim. */
export const defaultSpawner: ProcessSpawner = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
