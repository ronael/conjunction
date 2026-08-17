import type { ExecutionTarget, ReasoningEffort } from "./invocation.js";

export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface AgentRuntimeUsage {
  /** Runtime-reported wall/API duration, if exposed as structured data. */
  durationMs?: number;
  /** Runtime/provider-reported cost, only when supplied by the runtime. */
  costUsd?: number;
  /** Aggregate token usage, only from a structured runtime contract. */
  tokens?: AgentTokenUsage;
  /** Runtime/model identity records, when the runtime exposes them. */
  models?: {
    name: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUsd?: number;
  }[];
}

export interface AgentAvailability {
  available: boolean;
  /** Runtime version string when detectable, e.g. "codex-cli 0.144.1". */
  version?: string;
  /** Human-readable reason the runtime cannot be used. */
  reason?: string;
}

export interface AgentCapabilities {
  /** Adapter can enforce a read-only invocation mode. */
  supportsReadOnly: boolean;
  /** Adapter can request structured final output from the runtime. */
  supportsStructuredOutput: boolean;
  /** Conjunction reasoning-effort intentions this runtime can map truthfully. */
  reasoningEffort: readonly ReasoningEffort[];
}

export interface AgentRunInput {
  /** Target selected for this specific invocation. */
  target: ExecutionTarget;
  /** Portable Conjunction reasoning-effort intent for this invocation. */
  reasoningEffort: ReasoningEffort;
  /** Semantic instructions prepared by Conjunction before the adapter boundary. */
  instructions: string;
  /** The run's isolated worktree; the only filesystem the agent may touch. */
  workspacePath: string;
  timeoutMs: number;
  /** Cancellation, wired to Orchestrator.cancelRun. */
  signal?: AbortSignal;
  /** Streaming output; the orchestrator turns chunks into agent.output events. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Lot 7 reviewer mode: the runtime MUST run read-only (codex maps this to
   * `-s read-only`). There is no way to request a less restrictive sandbox.
   */
  readOnly?: boolean;
  /**
   * Optional JSON Schema for the agent's final message (codex maps this to
   * `--output-schema`). Runtimes without schema support ignore it; callers
   * must parse defensively anyway.
   */
  outputSchema?: unknown;
}

export interface AgentRunResult {
  /** null when the process was killed or could not be started. */
  exitCode: number | null;
  timedOut: boolean;
  /** True when the run ended because the AbortSignal fired. */
  aborted: boolean;
  /** The agent's final message, when the runtime exposes one. */
  lastMessage?: string;
  /** Optional structured runtime usage. Unknown means the runtime did not expose it reliably. */
  usage?: AgentRuntimeUsage;
}

/**
 * The port between core and a coding-agent runtime (codex, claude-code, …).
 *
 * Deliberate contract rules:
 * - one-shot run(): no interactive session model yet; send()/resume() can be
 *   added later without breaking this;
 * - the adapter reports PROCESS OUTCOME ONLY — it never decides pass/fail
 *   (verification, lot 3, is the only gate) and never reviews its own diff;
 * - the adapter knows nothing about branches, worktree lifecycle, or events;
 * - the adapter receives already-prepared instructions and must not know how a
 *   Task becomes product-facing prompt text;
 * - core defines this interface; concrete adapters live outside core
 *   (src/adapters/<runtime>/) and are wired in by the CLI.
 */
export interface AgentAdapter {
  /** Stable runtime id recorded on Run.runtime, e.g. "codex-cli". */
  readonly id: string;
  /** Runtime capabilities Conjunction may rely on without guessing. */
  capabilities(): AgentCapabilities;
  /** Cheap, side-effect-free check that the runtime is installed and usable. */
  detect(): Promise<AgentAvailability>;
  /** Runs one bounded, non-interactive attempt in the run's worktree. */
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface RuntimeRegistry {
  get(runtime: string): AgentAdapter | undefined;
  ids(): readonly string[];
}

export class StaticRuntimeRegistry implements RuntimeRegistry {
  #adapters = new Map<string, AgentAdapter>();

  constructor(adapters: readonly AgentAdapter[]) {
    for (const adapter of adapters) {
      this.#adapters.set(adapter.id, adapter);
    }
  }

  get(runtime: string): AgentAdapter | undefined {
    return this.#adapters.get(runtime);
  }

  ids(): readonly string[] {
    return [...this.#adapters.keys()].sort();
  }
}
