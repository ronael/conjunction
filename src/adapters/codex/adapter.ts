import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentAdapter,
  AgentAvailability,
  AgentRunInput,
  AgentRunResult,
} from "../../core/index.js";

import { buildPrompt } from "./prompt.js";
import { defaultSpawner, type ProcessSpawner } from "./process.js";

const execFileAsync = promisify(execFile);

const DETECT_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Hard safety floor: the agent always runs sandboxed, scoped to the run's
 * worktree. This is deliberately NOT a constructor option — never
 * `danger-full-access`, never `--dangerously-bypass-approvals-and-sandbox`.
 */
const SANDBOX_MODE = "workspace-write";

export interface CodexAdapterOptions {
  /** Binary to invoke. Default: "codex" (resolved via PATH). */
  codexBin?: string;
  /** Optional model override, passed as `codex exec -m <model>`. */
  model?: string;
  /** Process spawn seam, injected by tests. Default: child_process.spawn. */
  spawner?: ProcessSpawner;
  /** Grace period between SIGTERM and SIGKILL on timeout/abort. Default 5s. */
  killGraceMs?: number;
  /** Version probe seam, injected by tests. Default: `<bin> --version`. */
  probeVersion?: (bin: string) => Promise<string>;
}

/**
 * AgentAdapter for the Codex CLI (`codex exec`, non-interactive mode).
 *
 * Invocation: `codex exec -C <worktree> -s workspace-write --ephemeral
 * --color never -o <tmpfile> [-m <model>] -- <prompt>`.
 * The final agent message is read back from the `-o` file when written.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex-cli";

  #bin: string;
  #model?: string;
  #spawner: ProcessSpawner;
  #killGraceMs: number;
  #probeVersion: (bin: string) => Promise<string>;

  constructor(options: CodexAdapterOptions = {}) {
    this.#bin = options.codexBin ?? "codex";
    if (options.model !== undefined) {
      this.#model = options.model;
    }
    this.#spawner = options.spawner ?? defaultSpawner;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#probeVersion =
      options.probeVersion ??
      (async (bin) => {
        const { stdout } = await execFileAsync(bin, ["--version"], {
          timeout: DETECT_TIMEOUT_MS,
        });
        return stdout.trim();
      });
  }

  async detect(): Promise<AgentAvailability> {
    try {
      const version = await this.#probeVersion(this.#bin);
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: `\`${this.#bin} --version\` failed: ${(error as Error).message}`,
      };
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // A packet (correction or reviewer) replaces the task-derived prompt — it
    // already carries the task framing and the workspace/git safety rules.
    const prompt = input.promptOverride ?? buildPrompt(input.task);
    const lastMessageFile = path.join(tmpdir(), `conjunction-codex-${randomUUID()}.txt`);

    // Lot 7: the reviewer runs read-only — the ONLY two sandbox values this
    // adapter can ever emit are "workspace-write" (implementer) and
    // "read-only" (reviewer). Never danger-full-access, never configurable.
    const sandbox = input.readOnly === true ? "read-only" : SANDBOX_MODE;

    // Optional structured-output schema (codex --output-schema <FILE>).
    let schemaFile: string | undefined;
    if (input.outputSchema !== undefined) {
      schemaFile = path.join(tmpdir(), `conjunction-schema-${randomUUID()}.json`);
      await writeFile(schemaFile, JSON.stringify(input.outputSchema), "utf8");
    }

    const args = [
      "exec",
      "-C",
      input.workspacePath,
      "-s",
      sandbox,
      "--ephemeral",
      "--color",
      "never",
      "-o",
      lastMessageFile,
      ...(schemaFile !== undefined ? ["--output-schema", schemaFile] : []),
      ...(this.#model !== undefined ? ["-m", this.#model] : []),
      "--",
      prompt,
    ];

    const child = this.#spawner(this.#bin, args, {
      cwd: input.workspacePath,
      detached: true,
    });

    return new Promise<AgentRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        killTree();
      }, input.timeoutMs);

      let killEscalation: NodeJS.Timeout | undefined;

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (killEscalation !== undefined) {
          clearTimeout(killEscalation);
        }
        input.signal?.removeEventListener("abort", onAbort);
        void readLastMessage(lastMessageFile).then((lastMessage) => {
          if (schemaFile !== undefined) {
            void rm(schemaFile, { force: true }).catch(() => {});
          }
          const result: AgentRunResult = { exitCode, timedOut, aborted };
          if (lastMessage !== undefined) {
            result.lastMessage = lastMessage;
          }
          resolve(result);
        });
      };

      // detached=true made the child a process-group leader: signal the whole
      // group so subprocesses codex spawned die too, then escalate to SIGKILL.
      const killTree = (): void => {
        const signalGroup = (signal: NodeJS.Signals): void => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // group kill unsupported or already gone; fall back to the child
            }
          }
          child.kill(signal);
        };
        signalGroup("SIGTERM");
        killEscalation = setTimeout(() => {
          if (!settled) {
            signalGroup("SIGKILL");
          }
        }, this.#killGraceMs);
        killEscalation.unref();
      };

      const onAbort = (): void => {
        aborted = true;
        killTree();
      };
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.on("data", (chunk: Buffer) => {
        input.onOutput?.(chunk.toString("utf8"), "stdout");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        input.onOutput?.(chunk.toString("utf8"), "stderr");
      });
      child.once("error", (error: Error) => {
        input.onOutput?.(`failed to spawn ${this.#bin}: ${error.message}\n`, "stderr");
        finish(null);
      });
      child.once("exit", (code: number | null) => {
        finish(code);
      });
    });
  }
}

async function readLastMessage(file: string): Promise<string | undefined> {
  let content: string | undefined;
  try {
    const raw = (await readFile(file, "utf8")).trim();
    content = raw.length > 0 ? raw : undefined;
  } catch {
    // codex never wrote the file (crashed, killed, or had nothing to say)
  }
  await rm(file, { force: true }).catch(() => {});
  return content;
}
