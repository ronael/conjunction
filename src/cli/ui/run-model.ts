import type { Run, RunState, Task } from "../../core/index.js";
import type { CommandResult, VerificationCommand } from "../../verification/index.js";
import type { RunTaskResult } from "../run-command.js";

export type RunPhase = "setup" | "agent" | "verification" | "correcting" | "done";

export interface OutputLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export type VerifyStatus = "pending" | "running" | "passed" | "failed" | "timed-out";

export interface VerifyItem {
  name: string;
  status: VerifyStatus;
  exitCode?: number | null;
  durationMs?: number;
  /** Last lines of stderr, kept only for failed commands. */
  stderrTail?: string[];
}

/** Ring-buffer cap so a long run cannot grow memory without bound. */
export const MAX_OUTPUT_LINES = 2_000;
const STDERR_TAIL_LINES = 5;

/**
 * Plain-TS view model for the run TUI. The CLI flow writes into it through the
 * RunObserver seam; React reads it via useSyncExternalStore. The engine never
 * knows this class exists.
 */
export class RunModel {
  runId = "";
  taskTitle = "";
  branch = "";
  worktreePath = "";
  storeDir = "";

  phase: RunPhase = "setup";
  readonly startedAt = Date.now();
  finalState: RunState | "setup-error" | undefined;
  final: RunTaskResult | undefined;

  /** Pre-seeded by the caller from the configured verify commands. */
  verifyItems: VerifyItem[] = [];

  #lines: OutputLine[] = [];
  #partial: OutputLine | undefined;
  truncatedLines = 0;

  /** When true the output pane follows the tail; scrolling up disables it. */
  follow = true;
  /** Lines above the viewport bottom when not following. */
  scrollOffset = 0;

  #version = 0;
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  #emit(): void {
    this.#version++;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  get lineCount(): number {
    return this.#lines.length + (this.#partial === undefined ? 0 : 1);
  }

  /** All logical lines, including the trailing partial line if any. */
  get lines(): readonly OutputLine[] {
    return this.#partial === undefined ? this.#lines : [...this.#lines, this.#partial];
  }

  setContext(ctx: { run: Run; task: Task; repoRoot: string; storeDir: string }): void {
    this.runId = ctx.run.id;
    this.taskTitle = ctx.task.title;
    this.branch = ctx.run.branch ?? "";
    this.worktreePath = ctx.run.workspacePath ?? "";
    this.storeDir = ctx.storeDir;
    this.phase = "agent";
    this.#emit();
  }

  appendOutput(chunk: string, stream: OutputLine["stream"]): void {
    const parts = chunk.split("\n");
    let completed = 0;
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      if (index === 0 && this.#partial !== undefined) {
        this.#partial = { stream: this.#partial.stream, text: this.#partial.text + part };
      } else if (part.length > 0 || !isLast) {
        this.#partial = { stream, text: part };
      }
      if (!isLast && this.#partial !== undefined) {
        this.#lines.push(this.#partial);
        this.#partial = undefined;
        completed++;
      }
    }
    // While the user is scrolled up, keep the viewport pinned to the same
    // content by moving the (tail-relative) offset along with new lines.
    if (!this.follow) {
      this.scrollOffset += completed;
    }
    if (this.#lines.length > MAX_OUTPUT_LINES) {
      const overflow = this.#lines.length - MAX_OUTPUT_LINES;
      this.#lines.splice(0, overflow);
      this.truncatedLines += overflow;
      if (!this.follow) {
        this.scrollOffset = Math.max(0, this.scrollOffset - overflow);
      }
    }
    this.#emit();
  }

  startVerification(): void {
    this.phase = "verification";
    // reset for a fresh pass (initial run or the post-correction re-check)
    this.verifyItems = this.verifyItems.map((item) => ({ name: item.name, status: "pending" }));
    this.#emit();
  }

  /** Lot 6: verification failed; the single correction attempt is starting. */
  startCorrection(failedCommands: readonly string[]): void {
    this.phase = "correcting";
    this.appendOutput(
      `── correction attempt 2/2: fixing failed verification (${failedCommands.join(", ")}) ──\n`,
      "system",
    );
    this.#emit();
  }

  commandStarted(command: VerificationCommand): void {
    const item = this.verifyItems.find((candidate) => candidate.name === command.name);
    if (item !== undefined) {
      item.status = "running";
    } else {
      this.verifyItems.push({ name: command.name, status: "running" });
    }
    this.#emit();
  }

  commandFinished(result: CommandResult): void {
    const item = this.verifyItems.find((candidate) => candidate.name === result.name);
    if (item === undefined) {
      return;
    }
    item.status = result.timedOut ? "timed-out" : result.exitCode === 0 ? "passed" : "failed";
    item.exitCode = result.exitCode;
    item.durationMs = result.durationMs;
    if (item.status === "failed" || item.status === "timed-out") {
      const tail = result.stderr.trim().split("\n").filter(Boolean).slice(-STDERR_TAIL_LINES);
      if (tail.length > 0) {
        item.stderrTail = tail;
      }
    }
    this.#emit();
  }

  finish(result: RunTaskResult): void {
    this.phase = "done";
    this.final = result;
    this.finalState = result.run?.state ?? "setup-error";
    this.#emit();
  }

  /** Lines visible in a viewport of the given height. */
  visibleLines(viewportHeight: number): readonly OutputLine[] {
    const all = this.lines;
    if (all.length <= viewportHeight) {
      return all;
    }
    const maxOffset = all.length - viewportHeight;
    const offset = this.follow ? 0 : Math.min(this.scrollOffset, maxOffset);
    return all.slice(maxOffset - offset, all.length - offset);
  }

  scrollUp(lines: number): void {
    this.follow = false;
    this.scrollOffset += lines;
    this.#emit();
  }

  scrollDown(lines: number): void {
    if (this.follow) {
      return;
    }
    this.scrollOffset -= lines;
    if (this.scrollOffset <= 0) {
      this.scrollOffset = 0;
      this.follow = true;
    }
    this.#emit();
  }

  scrollToEnd(): void {
    this.follow = true;
    this.scrollOffset = 0;
    this.#emit();
  }
}
