import { render } from "ink";
import React from "react";

import type { RuntimeRegistry } from "../../core/index.js";
import { findRepoRoot } from "../../workspace/index.js";
import type { RunTaskOptions } from "../run-command.js";
import { runTask, selectedRuntimeTargets } from "../run-command.js";

import { RunApp } from "./run-app.js";
import { RunModel } from "./run-model.js";

/**
 * Runs the vertical slice behind the Ink TUI. This module is the ONLY place
 * where the UI meets the engine: it translates RunObserver callbacks into
 * model updates. Loaded via dynamic import — the plain/CI path never pulls in
 * ink or react.
 */
export async function runWithTui(
  options: RunTaskOptions,
  deps: { runtimeRegistry: RuntimeRegistry },
): Promise<number> {
  // Preflight in plain text: a TUI makes no sense when setup cannot succeed.
  for (const selected of selectedRuntimeTargets(options, options.workflow)) {
    const adapter = deps.runtimeRegistry.get(selected.target.runtime);
    if (!adapter) {
      process.stdout.write(`error: unknown agent runtime "${selected.target.runtime}"\n`);
      return 2;
    }
    if (
      selected.explicitEffort !== undefined &&
      !adapter.capabilities().reasoningEffort.includes(selected.explicitEffort)
    ) {
      const supported = adapter.capabilities().reasoningEffort;
      process.stdout.write(
        `error: runtime "${adapter.id}" does not support reasoning effort ` +
          `"${selected.explicitEffort}" (supported: ${supported.join(", ") || "none"})\n`,
      );
      return 2;
    }
    const availability = await adapter.detect();
    if (!availability.available) {
      process.stdout.write(
        `error: agent runtime "${adapter.id}" is not available: ` +
          `${availability.reason ?? "unknown reason"}\n`,
      );
      return 2;
    }
  }
  try {
    await findRepoRoot(options.repoPath);
  } catch {
    process.stdout.write(`error: not a git repository: ${options.repoPath}\n`);
    return 2;
  }

  const model = new RunModel();
  model.verifyItems = options.verifyCommands.map((command) => ({
    name: command.name,
    status: "pending",
  }));

  const controller = new AbortController();
  let quitResolve!: () => void;
  const quit = new Promise<void>((resolve) => {
    quitResolve = resolve;
  });
  let cancelRequested = false;

  const app = render(
    React.createElement(RunApp, {
      model,
      onCancel: () => {
        if (!cancelRequested) {
          cancelRequested = true;
          controller.abort();
        }
      },
      onQuit: () => quitResolve(),
    }),
  );

  const result = await runTask(options, {
    runtimeRegistry: deps.runtimeRegistry,
    out: () => {}, // the TUI renders everything; plain text stays for plain mode
    signal: controller.signal,
    observer: {
      context: (ctx) => model.setContext(ctx),
      agentOutput: (chunk, stream) => model.appendOutput(chunk, stream),
      driverStarted: () => model.driverStarted(),
      driverDecision: (decision) => model.driverDecision(decision),
      workerFinished: (outcome) => model.workerFinished(outcome),
      driverAccepted: () => model.driverAccepted(),
      finalVerificationStarted: () => model.finalVerificationStarted(),
      verificationStarted: () => model.startVerification(),
      verificationFinished: (passed) => model.verificationFinished(passed),
      commandStarted: (command) => model.commandStarted(command),
      commandFinished: (_command, commandResult) => model.commandFinished(commandResult),
      correctionStarted: (failedCommands) => model.startCorrection(failedCommands),
      reviewStarted: () => model.startReview(),
      reviewFinished: (review) => model.finishReview(review),
      observerStarted: () => model.observerStarted(),
    },
  });

  model.finish(result);
  await quit; // final panel stays up until the user dismisses it
  app.unmount();
  return result.exitCode;
}
