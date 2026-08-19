import type { RuntimeRegistry } from "../../core/index.js";
import { findRepoRoot } from "../../workspace/index.js";
import { runTask, type RunObserver, type RunTaskResult } from "../run-command.js";
import { RunModel } from "../ui/run-model.js";

import { ComposerModel } from "./composer-model.js";
import { ConfigStore } from "./config-store.js";
import { ResultActionsModel } from "./result-actions-model.js";

export type ProductPhase = "composer" | "execution" | "result";

/**
 * Top-level controller for the product flow: Composer -> Execution TUI ->
 * Result Actions. It calls the SAME runTask engine the CLI uses (no shelling),
 * and owns the single shared RunModel for the Execution TUI.
 */
export class ProductController {
  phase: ProductPhase = "composer";
  composer: ComposerModel;
  runModel: RunModel | undefined;
  result: ResultActionsModel | undefined;
  fatalError: string | undefined;

  #version = 0;
  #listeners = new Set<() => void>();
  #abort: AbortController | undefined;

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly configStore: ConfigStore,
    private readonly cwd: string,
  ) {
    this.composer = new ComposerModel(registry, configStore, cwd);
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

  async init(): Promise<void> {
    try {
      this.composer.repoRoot = await findRepoRoot(this.cwd);
    } catch {
      this.composer.repoError = `not a git repository: ${this.cwd}`;
    }
    await this.composer.init();
    this.#emit();
  }

  async startRun(): Promise<void> {
    if (this.composer.repoError !== undefined) {
      this.fatalError = this.composer.repoError;
      this.phase = "result";
      this.#emit();
      return;
    }
    const options = this.composer.buildRunOptions();
    const repoRoot = this.composer.repoRoot || this.cwd;

    this.#abort = new AbortController();
    const runModel = new RunModel();
    runModel.verifyItems = options.verifyCommands.map((command) => ({
      name: command.name,
      status: "pending",
    }));
    this.runModel = runModel;
    this.phase = "execution";
    this.#emit();

    let result: RunTaskResult;
    try {
      result = await runTask(options, {
        runtimeRegistry: this.registry,
        out: () => {},
        signal: this.#abort.signal,
        observer: executionObserver(runModel),
      });
    } catch (error) {
      this.fatalError = (error as Error).message;
      this.phase = "result";
      this.#emit();
      return;
    }

    // Persist the latest choices so the next launch is pre-configured.
    await this.configStore.save(this.composer.toConfig()).catch(() => {});

    runModel.finish(result);
    this.result = new ResultActionsModel(result, repoRoot);
    this.phase = "result";
    this.#emit();
  }

  cancel(): void {
    this.#abort?.abort();
  }

  exit(): void {
    this.#emit();
  }
}

/** Wires the shared Execution TUI model to the run's observer callbacks. */
export function executionObserver(model: RunModel): RunObserver {
  return {
    context: (ctx) => model.setContext(ctx),
    agentOutput: (chunk, stream) => model.appendOutput(chunk, stream),
    driverStarted: (target) => model.driverStarted(target),
    driverDecision: (decision) => model.driverDecision(decision),
    driverDecisionRefused: (decision, reason) => model.driverDecisionRefused(decision, reason),
    agentActivity: (activity) => model.agentActivity(activity),
    workerStarted: (target) => model.workerStarted(target),
    workerFinished: (outcome) => model.workerFinished(outcome),
    driverAccepted: () => model.driverAccepted(),
    finalVerificationStarted: () => model.finalVerificationStarted(),
    verificationStarted: () => model.startVerification(),
    verificationFinished: (passed) => model.verificationFinished(passed),
    commandStarted: (command) => model.commandStarted(command),
    commandFinished: (_command, commandResult) => model.commandFinished(commandResult),
    correctionStarted: (failedCommands) => model.startCorrection(failedCommands),
    reviewStarted: (target) => model.startReview(target),
    reviewFinished: (review) => model.finishReview(review),
    observerStarted: (target) => model.observerStarted(target),
  };
}
