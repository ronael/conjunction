import type { Task } from "./task.js";

export interface AgentAvailability {
  available: boolean;
  /** Runtime version string when detectable, e.g. "codex-cli 0.144.1". */
  version?: string;
  /** Human-readable reason the runtime cannot be used. */
  reason?: string;
}

export interface AgentRunInput {
  task: Task;
  /** The run's isolated worktree; the only filesystem the agent may touch. */
  workspacePath: string;
  timeoutMs: number;
  /** Cancellation, wired to Orchestrator.cancelRun. */
  signal?: AbortSignal;
  /** Streaming output; the orchestrator turns chunks into agent.output events. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /**
   * Lot 6 feedback loop: when set, this packet REPLACES the task-derived
   * prompt (it already contains the task framing and workspace rules).
   */
  correctionPacket?: string;
}

export interface AgentRunResult {
  /** null when the process was killed or could not be started. */
  exitCode: number | null;
  timedOut: boolean;
  /** True when the run ended because the AbortSignal fired. */
  aborted: boolean;
  /** The agent's final message, when the runtime exposes one. */
  lastMessage?: string;
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
 * - core defines this interface; concrete adapters live outside core
 *   (src/adapters/<runtime>/) and are wired in by the CLI.
 */
export interface AgentAdapter {
  /** Stable runtime id recorded on Run.runtime, e.g. "codex-cli". */
  readonly id: string;
  /** Cheap, side-effect-free check that the runtime is installed and usable. */
  detect(): Promise<AgentAvailability>;
  /** Runs one bounded, non-interactive attempt in the run's worktree. */
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
