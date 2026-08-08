import { execFile } from "node:child_process";

/** One named deterministic check, e.g. `{ name: "typecheck", command: "pnpm", args: ["exec", "tsc", "--noEmit"] }`. */
export interface VerificationCommand {
  name: string;
  command: string;
  args?: string[];
  /** Per-command timeout; overrides the engine default. */
  timeoutMs?: number;
}

export interface CommandResult {
  name: string;
  command: string;
  args: string[];
  /** null when the process could not be started or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerificationResult {
  passed: boolean;
  results: CommandResult[];
}

export interface RunVerificationOptions {
  /** Working directory all commands run in (typically the run's worktree). */
  cwd: string;
  /** Stop after the first failing command. Default: true. */
  failFast?: boolean;
  /** Default per-command timeout. Default: 5 minutes. */
  timeoutMs?: number;
  /** Progress seam for UIs: fired right before a command starts. */
  onCommandStart?: (command: VerificationCommand) => void;
  /** Progress seam for UIs: fired after a command finishes (any outcome). */
  onCommandEnd?: (command: VerificationCommand, result: CommandResult) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface ExecErrorShape {
  code?: number | string;
  signal?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message: string;
}

function isSuccess(result: CommandResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

/**
 * Runs the configured commands sequentially in `cwd` and returns a structured
 * result. Commands are spawned with execFile and argument arrays — no shell,
 * no string interpolation — so a command name can never smuggle in extra
 * arguments or shell syntax.
 *
 * A failing command never throws: failure is data (exitCode/timedOut), so the
 * caller can route it back to a worker later.
 */
export async function runVerification(
  commands: readonly VerificationCommand[],
  options: RunVerificationOptions,
): Promise<VerificationResult> {
  const failFast = options.failFast ?? true;
  const results: CommandResult[] = [];

  for (const command of commands) {
    options.onCommandStart?.(command);
    const result = await runCommand(command, options);
    options.onCommandEnd?.(command, result);
    results.push(result);
    if (failFast && !isSuccess(result)) {
      break;
    }
  }

  return { passed: results.every(isSuccess), results };
}

async function runCommand(
  command: VerificationCommand,
  options: RunVerificationOptions,
): Promise<CommandResult> {
  const args = [...(command.args ?? [])];
  const timeoutMs = command.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    execFile(
      command.command,
      args,
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const base: CommandResult = {
          name: command.name,
          command: command.command,
          args,
          exitCode: 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs: Date.now() - startedAt,
          timedOut: false,
        };
        if (!error) {
          resolve(base);
          return;
        }
        const execError = error as ExecErrorShape;
        // execFile's timeout kills the child (SIGTERM) and sets killed=true;
        // a non-zero exit sets a numeric code instead.
        const timedOut = execError.killed === true && execError.signal === "SIGTERM";
        resolve({
          ...base,
          exitCode: typeof execError.code === "number" ? execError.code : null,
          timedOut,
        });
      },
    );
  });
}
