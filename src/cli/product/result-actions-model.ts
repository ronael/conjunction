import path from "node:path";

import { RunStore, type StoredRun } from "../run-store.js";
import type { RunTaskResult } from "../run-command.js";
import { discardRun, landingDiff, landRun, runReportText, type LandOutcome } from "./services.js";

export type ResultView =
  | "actions"
  | "diff"
  | "report"
  | "discard-confirm"
  | "applied"
  | "discarded"
  | "kept"
  | "apply-error";

export type ResultAction = "apply" | "diff" | "report" | "keep" | "discard";

/**
 * Plain-TS model for the post-run Result Actions. Reads the real Run (never a
 * second state machine) and drives the same services as the CLI land/report.
 */
export class ResultActionsModel {
  result: RunTaskResult;
  repoRoot: string;
  store: RunStore;
  stored: StoredRun;

  view: ResultView = "actions";
  index = 0;
  confirmIndex = 0; // discard confirmation default = Cancel (0)
  diffText = "";
  reportText = "";
  statusLines: string[] = [];
  landOutcome: LandOutcome | undefined;

  diffOffset = 0;
  reportOffset = 0;

  #version = 0;
  #listeners = new Set<() => void>();

  constructor(result: RunTaskResult, repoRoot: string) {
    this.result = result;
    this.repoRoot = repoRoot;
    this.store = new RunStore(path.join(repoRoot, ".conjunction", "runs"));
    this.stored = { run: result.run!, task: result.task! };
  }

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

  get runId(): string {
    return this.stored.run.id;
  }

  get state(): string {
    return this.stored.run.state;
  }

  get completed(): boolean {
    return this.stored.run.state === "completed";
  }

  get actions(): ResultAction[] {
    // Apply is only offered for a completed run that isn't already landed/discarded.
    const base: ResultAction[] = [];
    if (this.completed && this.stored.run.landed === undefined) {
      base.push("apply");
    }
    base.push("diff", "report");
    if (this.completed && this.stored.run.landed === undefined) {
      base.push("discard");
    }
    base.push("keep");
    return base;
  }

  move(offset: number): void {
    const total = this.actions.length;
    this.index = clamp(this.index + offset, 0, Math.max(0, total - 1));
    this.#emit();
  }

  moveConfirm(offset: number): void {
    this.confirmIndex = clamp(this.confirmIndex + offset, 0, 1);
    this.#emit();
  }

  async viewDiff(): Promise<void> {
    if (this.stored.run.workspacePath === undefined) {
      this.diffText = "(no worktree recorded)";
    } else {
      this.diffText = await landingDiff(this.stored.run.workspacePath);
    }
    this.diffOffset = 0;
    this.view = "diff";
    this.#emit();
  }

  async viewReport(): Promise<void> {
    this.reportText = await runReportText({
      repoRoot: this.repoRoot,
      store: this.store,
      stored: this.stored,
    });
    this.reportOffset = 0;
    this.view = "report";
    this.#emit();
  }

  async apply(): Promise<void> {
    const outcome = await landRun({
      repoRoot: this.repoRoot,
      store: this.store,
      stored: this.stored,
      cleanup: true,
    });
    this.landOutcome = outcome;
    if (outcome.ok) {
      this.statusLines = [...outcome.messages];
      this.view = "applied";
    } else {
      this.statusLines = [`✗ ${outcome.error ?? "could not apply changes"}`];
      this.view = "apply-error";
    }
    this.#emit();
  }

  async keep(): Promise<void> {
    this.statusLines = [
      "Changes kept isolated.",
      `Run ${this.runId.slice(0, 8)} can be resumed/applied later.`,
      `  conjunction land ${this.runId}`,
    ];
    this.view = "kept";
    this.#emit();
  }

  openDiscard(): void {
    this.confirmIndex = 0; // default = Cancel
    this.view = "discard-confirm";
    this.#emit();
  }

  async discard(): Promise<void> {
    const outcome = await discardRun({
      repoRoot: this.repoRoot,
      store: this.store,
      stored: this.stored,
    });
    this.statusLines = outcome.ok ? outcome.messages : [`✗ ${outcome.error}`];
    this.view = outcome.ok ? "discarded" : "apply-error";
    this.#emit();
  }

  back(): void {
    this.view = "actions";
    this.#emit();
  }

  scrollDiff(lines: number): void {
    this.diffOffset = Math.max(0, this.diffOffset + lines);
    this.#emit();
  }
  scrollReport(lines: number): void {
    this.reportOffset = Math.max(0, this.reportOffset + lines);
    this.#emit();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
