import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/** Error raised when a git invocation fails; carries the failing stderr. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export class NotAGitRepositoryError extends GitError {
  constructor(cwd: string, args: readonly string[], stderr: string) {
    super(`not a git repository: ${cwd}`, args, cwd, null, stderr);
    this.name = "NotAGitRepositoryError";
  }
}

interface ExecErrorShape {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message: string;
}

/**
 * Runs git with an argument array. NEVER uses a shell: args are passed
 * verbatim to execFile, so no interpolation or injection is possible.
 */
export async function execGit(
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    return { stdout, stderr };
  } catch (error) {
    const execError = error as ExecErrorShape;
    const stderr = execError.stderr ?? "";
    const exitCode = typeof execError.code === "number" ? execError.code : null;
    const detail = stderr.trim() || execError.message;
    throw new GitError(
      `git ${args.join(" ")} failed in ${options.cwd}: ${detail}`,
      args,
      options.cwd,
      exitCode,
      stderr,
    );
  }
}

/** Resolves the repository root containing `cwd`, or throws NotAGitRepositoryError. */
export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch (error) {
    if (error instanceof GitError) {
      throw new NotAGitRepositoryError(cwd, error.args, error.stderr);
    }
    throw error;
  }
}
