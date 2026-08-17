import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeUsage,
  ReasoningEffort,
} from "../../core/index.js";
import { defaultSpawner, type ProcessSpawner } from "../process.js";

const execFileAsync = promisify(execFile);

const DETECT_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

const READ_ONLY_TOOLS = "Read,Glob,Grep,LS";

const CLAUDE_EFFORT: Partial<Record<ReasoningEffort, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  maximum: "max",
};

export interface ClaudeAdapterOptions {
  /** Binary to invoke. Default: "claude" (resolved via PATH). */
  claudeBin?: string;
  /** Process spawn seam, injected by tests. Default: child_process.spawn. */
  spawner?: ProcessSpawner;
  /** Grace period between SIGTERM and SIGKILL on timeout/abort. Default 5s. */
  killGraceMs?: number;
  /** Version probe seam, injected by tests. Default: `<bin> --version`. */
  probeVersion?: (bin: string) => Promise<string>;
}

/**
 * AgentAdapter for Claude Code (`claude -p`, non-interactive print mode).
 *
 * Writer invocation: `claude -p --output-format text --no-session-persistence
 * --permission-mode acceptEdits [--model <model>] [--effort <level>] <prompt>`.
 * With `outputSchema`, Claude requires `--output-format json --json-schema`
 * and returns the contract payload in the transport envelope's
 * `structured_output` field.
 *
 * Read-only invocation: switches to `--permission-mode plan` and restricts the
 * available built-in tools to read-only file navigation tools.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude-code";

  #bin: string;
  #spawner: ProcessSpawner;
  #killGraceMs: number;
  #probeVersion: (bin: string) => Promise<string>;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#bin = options.claudeBin ?? "claude";
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

  capabilities(): AgentCapabilities {
    return {
      supportsReadOnly: true,
      supportsStructuredOutput: true,
      // Claude Code 2.1.220 exposes --effort low|medium|high|xhigh|max.
      // Conjunction has no xhigh intent; `maximum` maps to `max`.
      reasoningEffort: ["low", "medium", "high", "maximum"],
    };
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
    const structuredOutput = input.outputSchema !== undefined;
    const args = [
      "-p",
      "--output-format",
      structuredOutput ? "json" : "text",
      "--no-session-persistence",
      "--permission-mode",
      input.readOnly === true ? "plan" : "acceptEdits",
      ...(input.readOnly === true ? ["--tools", READ_ONLY_TOOLS] : []),
      ...(input.target.model !== undefined ? ["--model", input.target.model] : []),
      ...effortArgs(input.reasoningEffort),
      ...(structuredOutput ? ["--json-schema", JSON.stringify(input.outputSchema)] : []),
      input.instructions,
    ];

    const child = this.#spawner(this.#bin, args, {
      cwd: input.workspacePath,
      detached: true,
    });

    return new Promise<AgentRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let stdout = "";

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
        const envelope = structuredOutput ? parseClaudeEnvelope(stdout) : undefined;
        const result: AgentRunResult = { exitCode, timedOut, aborted };
        const lastMessage = structuredOutput
          ? structuredOutputLastMessage(stdout, envelope?.raw)
          : stdout.trim();
        if (lastMessage.length > 0) {
          result.lastMessage = lastMessage;
        }
        if (envelope?.usage !== undefined) {
          result.usage = envelope.usage;
        }
        resolve(result);
      };

      const killTree = (): void => {
        const signalGroup = (signal: NodeJS.Signals): void => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // group kill unsupported or already gone; fall back to child
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
        const text = chunk.toString("utf8");
        stdout += text;
        input.onOutput?.(text, "stdout");
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

function effortArgs(effort: ReasoningEffort): string[] {
  const mapped = CLAUDE_EFFORT[effort];
  return mapped === undefined ? [] : ["--effort", mapped];
}

function structuredOutputLastMessage(
  stdout: string,
  parsedEnvelope?: Record<string, unknown>,
): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const envelope = parsedEnvelope ?? parseJsonObject(trimmed);
  if (
    envelope !== undefined &&
    Object.prototype.hasOwnProperty.call(envelope, "structured_output")
  ) {
    const structured = JSON.stringify(
      (envelope as { structured_output: unknown }).structured_output,
    );
    if (structured !== undefined) {
      return structured;
    }
  }
  return trimmed;
}

function parseClaudeEnvelope(
  stdout: string,
): { raw: Record<string, unknown>; usage?: AgentRuntimeUsage } | undefined {
  const raw = parseJsonObject(stdout.trim());
  if (raw === undefined) {
    return undefined;
  }
  const usage: AgentRuntimeUsage = {};
  const duration = numberField(raw.duration_ms) ?? numberField(raw.duration_api_ms);
  if (duration !== undefined) {
    usage.durationMs = duration;
  }
  const cost = numberField(raw.total_cost_usd);
  if (cost !== undefined) {
    usage.costUsd = cost;
  }
  const aggregate = parseTokenUsage(raw.usage);
  if (aggregate !== undefined) {
    usage.tokens = aggregate;
  }
  const modelUsage = parseModelUsage(raw.modelUsage);
  if (modelUsage !== undefined) {
    usage.models = modelUsage;
  }
  return { raw, ...(Object.keys(usage).length > 0 ? { usage } : {}) };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseTokenUsage(value: unknown): NonNullable<AgentRuntimeUsage["tokens"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const tokens: NonNullable<AgentRuntimeUsage["tokens"]> = {};
  assignNumber(tokens, "inputTokens", numberField(record.input_tokens));
  assignNumber(tokens, "outputTokens", numberField(record.output_tokens));
  assignNumber(tokens, "cacheReadInputTokens", numberField(record.cache_read_input_tokens));
  assignNumber(tokens, "cacheCreationInputTokens", numberField(record.cache_creation_input_tokens));
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function parseModelUsage(value: unknown): NonNullable<AgentRuntimeUsage["models"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const models: NonNullable<AgentRuntimeUsage["models"]> = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const model: NonNullable<AgentRuntimeUsage["models"]>[number] = { name };
    assignNumber(model, "inputTokens", numberField(record.inputTokens));
    assignNumber(model, "outputTokens", numberField(record.outputTokens));
    assignNumber(model, "cacheReadInputTokens", numberField(record.cacheReadInputTokens));
    assignNumber(model, "cacheCreationInputTokens", numberField(record.cacheCreationInputTokens));
    assignNumber(model, "costUsd", numberField(record.costUSD));
    models.push(model);
  }
  return models.length > 0 ? models : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assignNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: number | undefined,
): void {
  if (value !== undefined) {
    target[key] = value as Exclude<T[K], undefined>;
  }
}
