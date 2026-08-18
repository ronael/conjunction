import type { DriverDecisionRecord, Run, RunReview, RunState, Task } from "../../core/index.js";
import { findingsSummary, formatDuration } from "../format.js";
import type { CommandResult, VerificationCommand } from "../../verification/index.js";
import type { RunTaskResult } from "../run-command.js";

export type RunPhase = "setup" | "agent" | "verification" | "correcting" | "review" | "done";

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

export type StepStatus = "pending" | "active" | "done" | "failed";

/** One row of the Daytona-style phase checklist. */
export interface ChecklistStep {
  id: string;
  label: string;
  status: StepStatus;
  /** Right-aligned dim detail: branch, duration, "typecheck failed", … */
  detail?: string;
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
  /** Brief file path; empty for an inline (command-line) description. */
  briefPath = "";
  workflow = "";

  phase: RunPhase = "setup";
  readonly startedAt = Date.now();
  finalState: RunState | "setup-error" | undefined;
  final: RunTaskResult | undefined;

  /** Daytona-style phase checklist, filled in as the run progresses. */
  steps: ChecklistStep[] = [{ id: "workspace", label: "Workspace ready", status: "active" }];
  #stepStartedAt = new Map<string, number>([["workspace", Date.now()]]);
  #verifyRound = 0;

  /** Quality workflow step counters (TUI projection only). */
  #driverStepCount = 0;
  #workerStepCount = 0;
  #currentWorkerStepId = "";

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

  get contextReady(): boolean {
    return this.runId.length > 0;
  }

  /** Id of the checklist step the verifyItems currently belong to. */
  get currentVerifyStepId(): string {
    return `verification-${this.#verifyRound}`;
  }

  setContext(ctx: { run: Run; task: Task; repoRoot: string; storeDir: string }): void {
    this.runId = ctx.run.id;
    this.taskTitle = ctx.task.title;
    this.branch = ctx.run.branch ?? "";
    this.worktreePath = ctx.run.workspacePath ?? "";
    this.storeDir = ctx.storeDir;
    this.briefPath = ctx.task.source?.kind === "file" ? ctx.task.source.path : "";
    this.workflow = ctx.run.workflow ?? "";
    this.phase = "agent";

    this.#completeStep("workspace", this.branch);
    if (this.workflow === "quality") {
      this.#startQualityDriver();
    } else {
      this.#startStep({ id: "agent-1", label: "Agent (attempt 1)" });
    }
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
    this.#verifyRound++;
    if (this.workflow !== "quality") {
      this.#completeStep(this.#verifyRound === 1 ? "agent-1" : "agent-2");
    }
    // skip the verification step entirely when nothing is configured
    if (this.verifyItems.length > 0) {
      this.#startStep({
        id: `verification-${this.#verifyRound}`,
        label:
          this.workflow === "quality"
            ? `Verification #${this.#verifyRound}`
            : this.#verifyRound === 1
              ? "Verification"
              : "Verification (attempt 2)",
      });
    }
    // reset for a fresh pass (initial run or the post-correction re-check)
    this.verifyItems = this.verifyItems.map((item) => ({ name: item.name, status: "pending" }));
    this.#emit();
  }

  /** Verification finished; resolves the verification step's status/detail. */
  verificationFinished(passed: boolean): void {
    const step = this.steps.find(
      (candidate) => candidate.id === `verification-${this.#verifyRound}`,
    );
    if (step === undefined) {
      return;
    }
    if (passed) {
      this.#completeStep(step.id);
    } else {
      const failedNames = this.verifyItems
        .filter((item) => item.status === "failed" || item.status === "timed-out")
        .map((item) => item.name);
      this.#failStep(step.id, `${failedNames.join(", ")} failed`);
    }
    this.#emit();
  }

  /** Lot 6: verification failed; the single correction attempt is starting. */
  startCorrection(failedCommands: readonly string[]): void {
    this.phase = "correcting";
    this.#startStep({ id: "agent-2", label: "Correction (attempt 2)" });
    this.appendOutput(
      `── correction attempt 2/2: fixing failed verification (${failedCommands.join(", ")}) ──\n`,
      "system",
    );
    this.#emit();
  }

  /** Lot 7: the independent reviewer is starting. */
  startReview(): void {
    this.phase = "review";
    this.#startStep({ id: "review", label: "Review" });
    this.#emit();
  }

  /** Lot 7: reviewer finished (possibly with an advisory error). */
  finishReview(review: RunReview): void {
    if (review.error !== undefined) {
      // advisory failure is not a run failure — keep the step green
      this.#completeStep("review", "unavailable (advisory)");
    } else {
      this.#completeStep("review", findingsSummary(review.findings));
    }
    this.#emit();
  }

  /** Quality workflow: the Driver invocation is starting. */
  driverStarted(): void {
    this.phase = "agent";
    if (this.#currentWorkerStepId.length > 0) {
      this.#completeStep(this.#currentWorkerStepId);
      this.#currentWorkerStepId = "";
    }
    this.#startQualityDriver();
    this.#emit();
  }

  /** Quality workflow: the Driver produced a decision. */
  driverDecision(decision: DriverDecisionRecord): void {
    const driverStep = this.#activeQualityDriverStep();
    if (driverStep === undefined) {
      return;
    }
    switch (decision.action) {
      case "delegate": {
        this.#completeStep(driverStep);
        this.#workerStepCount++;
        this.#currentWorkerStepId = `worker-${this.#workerStepCount}`;
        this.#startStep({
          id: this.#currentWorkerStepId,
          label: `Worker #${this.#workerStepCount}`,
        });
        break;
      }
      case "verify": {
        this.#completeStep(driverStep);
        break;
      }
      case "accept": {
        this.#completeStep(driverStep);
        break;
      }
      case "stop": {
        this.#failStep(driverStep, "stopped");
        break;
      }
    }
    this.#emit();
  }

  /** Quality workflow: a Worker invocation finished. */
  workerFinished(): void {
    if (this.#currentWorkerStepId.length > 0) {
      this.#completeStep(this.#currentWorkerStepId);
    }
    this.#emit();
  }

  /** Quality workflow: the Driver accepted the implementation. */
  driverAccepted(): void {
    const driverStep = this.#activeQualityDriverStep();
    if (driverStep !== undefined) {
      this.#completeStep(driverStep);
    }
    this.#emit();
  }

  /** Quality workflow: the final verification before review is starting. */
  finalVerificationStarted(): void {
    this.phase = "verification";
    this.#verifyRound++;
    this.#startStep({ id: `verification-${this.#verifyRound}`, label: "Final verification" });
    this.verifyItems = this.verifyItems.map((item) => ({ name: item.name, status: "pending" }));
    this.#emit();
  }

  /** Lot 4: the post-run Observer is starting. */
  observerStarted(): void {
    this.phase = "done";
    this.#startStep({ id: "observer", label: "Observer" });
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
    // resolve any step still open (agent failure, cancel mid-flight, …)
    for (const step of this.steps) {
      if (step.status === "active" || step.status === "pending") {
        if (this.finalState === "completed") {
          this.#completeStep(step.id);
        } else {
          this.#failStep(step.id, this.finalState === "cancelled" ? "cancelled" : "failed");
        }
      }
    }
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

  #startStep(step: { id: string; label: string }): void {
    this.steps.push({ ...step, status: "active" });
    this.#stepStartedAt.set(step.id, Date.now());
  }

  #startQualityDriver(): void {
    this.#driverStepCount++;
    this.#startStep({
      id: `driver-${this.#driverStepCount}`,
      label: `Driver #${this.#driverStepCount}`,
    });
  }

  #activeQualityDriverStep(): string | undefined {
    const step = this.steps.find(
      (candidate) => candidate.status === "active" && candidate.id.startsWith("driver-"),
    );
    return step?.id;
  }

  #completeStep(id: string, detail?: string): void {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (step === undefined) {
      return;
    }
    step.status = "done";
    const started = this.#stepStartedAt.get(id);
    const resolved =
      detail ?? (started === undefined ? undefined : formatDuration(Date.now() - started));
    if (resolved !== undefined) {
      step.detail = resolved;
    }
  }

  #failStep(id: string, detail: string): void {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (step === undefined) {
      return;
    }
    step.status = "failed";
    step.detail = detail;
  }
}
