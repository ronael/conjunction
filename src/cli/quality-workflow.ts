import { createHash } from "node:crypto";
import path from "node:path";

import type {
  DriverProgressFacts,
  DriverTargetOption,
  ExecutionTarget,
  ReasoningEffort,
  Run,
  RuntimeRegistry,
} from "../core/index.js";
import {
  buildDelegatedWorkerPacket,
  buildDriverPacket,
  buildReviewerPacket,
  DEFAULT_DRIVER_LIMITS,
  DRIVER_DECISION_SCHEMA,
  parseDriverDecision,
  UnsupportedRuntimeCapabilityError,
  workflowIncludes,
} from "../core/index.js";
import { getCurrentBranch, getHeadCommit, getWorktreeDiff } from "../workspace/index.js";

import { findingsSummary } from "./format.js";
import type {
  RunTaskDeps,
  RunTaskOptions,
  RunTaskResult,
  WorkerTargetInput,
} from "./run-command.js";
import { createRunExecutionSession } from "./run-session.js";

const DEFAULT_DRIVER_TARGET_ID = "worker";

function stepLine(symbol: string, label: string, detail?: string): string {
  const left = `${symbol} ${label}`;
  return detail === undefined ? `${left}\n` : `${left.padEnd(28)}${detail}\n`;
}

export async function runQualityTask(
  options: RunTaskOptions,
  deps: RunTaskDeps,
): Promise<RunTaskResult> {
  const { out, observer } = deps;
  if (options.verifyCommands.length === 0) {
    out("error: workflow quality requires at least one --verify command\n");
    return { exitCode: 2, repoRoot: "", storeDir: "" };
  }

  const driverTarget = options.driverTarget ?? options.workerTarget;
  const criticTarget = options.criticTarget ?? options.workerTarget;
  const workerTargetInputs = normalizeWorkerTargets(options.workerTargets, options.workerTarget);
  const limits = { ...DEFAULT_DRIVER_LIMITS, ...(options.qualityLimits ?? {}) };
  const preflightInput: PreflightInput = {
    runtimeRegistry: deps.runtimeRegistry,
    driverTarget,
    workerTargets: workerTargetInputs,
    criticTarget,
  };
  if (options.driverReasoningEffort !== undefined) {
    preflightInput.driverReasoningEffort = options.driverReasoningEffort;
  }
  if (options.criticReasoningEffort !== undefined) {
    preflightInput.criticReasoningEffort = options.criticReasoningEffort;
  }
  const preflight = await preflightQualityTargets(preflightInput);
  if (preflight.ok === false) {
    out(`${preflight.message}\n`);
    return { exitCode: 2, repoRoot: "", storeDir: "" };
  }
  const allowedWorkerTargets = preflight.workerTargets;

  let session: Awaited<ReturnType<typeof createRunExecutionSession>>;
  try {
    session = await createRunExecutionSession(options, deps, { failedCommandSymbol: "x" });
  } catch {
    out(`error: not a git repository: ${options.repoPath}\n`);
    return { exitCode: 2, repoRoot: "", storeDir: "" };
  }
  const { repoRoot, orchestrator, store } = session;
  const flush = session.flush;
  const throwIfAborted = session.throwIfAborted;

  const { brief } = options;
  const task = orchestrator.createTask({
    title: brief.title,
    objective: brief.content,
    source: brief.source,
  });
  const run = orchestrator.createRun(task.id, options.workerTarget, options.workflow);
  run.quality = {
    driverTarget,
    workerTargets: allowedWorkerTargets,
    criticTarget,
    limits,
  };

  out(`run:      ${run.id}\ntask:     ${task.title}\n`);
  if (brief.source.kind === "file") {
    out(`brief:    ${brief.source.path}\n`);
  }
  out(`workflow: ${options.workflow}\n\n`);

  try {
    throwIfAborted();
    run.baseBranch = await getCurrentBranch(repoRoot);
    run.baseCommit = await getHeadCommit(repoRoot);
    await orchestrator.startRun(run.id);
    await flush(task, run);
    out(stepLine("✓", "Workspace ready", run.branch));
    out(`  worktree: ${run.workspacePath ?? "-"}\n`);
    observer?.context?.({ run, task, repoRoot, storeDir: store.dir });

    while (run.state === "running") {
      throwIfAborted();
      if ((run.driverDecisions?.length ?? 0) >= limits.maxDriverDecisions) {
        orchestrator.failRun(
          run.id,
          `driver decision limit reached (${limits.maxDriverDecisions})`,
        );
        break;
      }

      const diff = await getDiff(run);
      const progress = progressFacts(run, allowedWorkerTargets, diff);
      const driverPacket = buildDriverPacket({
        task,
        run,
        allowedWorkerTargets,
        diff,
        verificationFresh: verificationIsFresh(run),
        limits,
        progress,
      });

      out("\n-- driver --\n");
      const lastWorker = lastWritableInvocation(run);
      const driverInvoke = await orchestrator.invokeAgent(run.id, {
        role: "driver",
        instructions: driverPacket,
        target: driverTarget,
        ...(options.driverReasoningEffort !== undefined
          ? { explicitReasoningEffort: options.driverReasoningEffort }
          : {}),
        ...(lastWorker !== undefined ? { parentInvocationId: lastWorker.id } : {}),
        timeoutMs: options.timeoutMinutes * 60_000,
        readOnly: true,
        outputSchema: DRIVER_DECISION_SCHEMA,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        onOutput: (chunk, stream) => {
          observer?.agentOutput?.(chunk, stream);
          out(chunk);
        },
      });
      await flush(task, run);
      if (run.state !== "running") {
        break;
      }

      const parsed = parseDriverDecision(driverInvoke.result.lastMessage ?? "");
      if (!parsed.ok) {
        orchestrator.failRun(run.id, `invalid driver decision: ${parsed.error}`);
        break;
      }
      const decision = orchestrator.recordDriverDecision(
        run.id,
        driverInvoke.invocation.id,
        parsed.decision,
      );
      await flush(task, run);

      if (decision.action === "stop") {
        orchestrator.failRun(run.id, `driver stopped: ${decision.reason}`);
        break;
      }

      if (decision.action === "verify") {
        out("\n-- verification --\n");
        observer?.verificationStarted?.();
        await orchestrator.verifyRunCheckpoint(run.id);
        observer?.verificationFinished?.(run.verificationResult?.passed ?? false);
        await flush(task, run);
        continue;
      }

      if (decision.action === "accept") {
        const refusal = acceptRefusalReason(run);
        if (refusal !== undefined) {
          orchestrator.failRun(run.id, `driver accept refused: ${refusal}`);
          break;
        }
        run.quality.acceptedDecisionId = decision.id;
        run.result = { summary: `driver accepted: ${decision.reason}` };
        out(stepLine("✓", "Driver accepted", decision.reason));
        await flush(task, run);

        if (workflowIncludes(options.workflow, "critic")) {
          out("\n-- final verification --\n");
          observer?.verificationStarted?.();
          await orchestrator.verifyRun(run.id, { review: true });
          observer?.verificationFinished?.(run.verificationResult?.passed ?? false);
          await flush(task, run);
          if ((run.state as string) !== "reviewing") {
            break;
          }

          out("\n-- review --\n");
          observer?.reviewStarted?.();
          const reviewDiff = await getDiff(run);
          const packet = buildReviewerPacket({
            task,
            diff: reviewDiff,
            verification: (session.lastVerification()?.results ?? []).map((result) => ({
              name: result.name,
              passed: !result.timedOut && result.exitCode === 0,
            })),
          });
          await orchestrator.reviewRun(run.id, packet, {
            timeoutMs: options.timeoutMinutes * 60_000,
            target: criticTarget,
            ...(options.criticReasoningEffort !== undefined
              ? { explicitReasoningEffort: options.criticReasoningEffort }
              : {}),
            parentInvocationId: driverInvoke.invocation.id,
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
            onOutput: (chunk, stream) => {
              observer?.agentOutput?.(chunk, stream);
              out(chunk);
            },
          });
          await flush(task, run);
          if (run.review !== undefined) {
            observer?.reviewFinished?.(run.review);
          }
        }
        break;
      }

      if (decision.action === "delegate") {
        const activeWritable = (run.invocations ?? []).find(
          (invocation) =>
            invocation.role === "worker" &&
            invocation.readOnly !== true &&
            invocation.state === "running",
        );
        if (activeWritable !== undefined) {
          orchestrator.failRun(run.id, `writable invocation already running: ${activeWritable.id}`);
          break;
        }
        if (progress.writableInvocationCount >= limits.maxWritableInvocations) {
          orchestrator.failRun(
            run.id,
            `writable invocation limit reached (${limits.maxWritableInvocations})`,
          );
          break;
        }
        const selectedTarget = allowedWorkerTargets.find((entry) => entry.id === decision.targetId);
        if (selectedTarget === undefined) {
          orchestrator.failRun(
            run.id,
            `driver selected unauthorized target "${decision.targetId ?? ""}"`,
          );
          break;
        }

        const workerDiff = await getDiff(run);
        const workerPacketInput = {
          task,
          objective: decision.objective ?? "",
          ...(decision.guidance !== undefined ? { guidance: decision.guidance } : {}),
          diff: workerDiff,
          reason: decision.reason,
        };
        const workerPacket = buildDelegatedWorkerPacket(
          run.verificationResult !== undefined
            ? { ...workerPacketInput, latestVerification: run.verificationResult }
            : workerPacketInput,
        );
        out("\n-- worker --\n");
        try {
          const workerInvoke = await orchestrator.invokeAgent(run.id, {
            role: "worker",
            instructions: workerPacket,
            target: selectedTarget.target,
            ...(decision.reasoningEffort !== undefined
              ? { explicitReasoningEffort: decision.reasoningEffort }
              : {}),
            parentInvocationId: driverInvoke.invocation.id,
            timeoutMs: options.timeoutMinutes * 60_000,
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
            onOutput: (chunk, stream) => {
              observer?.agentOutput?.(chunk, stream);
              out(chunk);
            },
          });
          const afterWorkerDiff = await getDiff(run);
          recordWorkspaceChange(workerInvoke.invocation, workerDiff, afterWorkerDiff);
        } catch (error) {
          if (error instanceof UnsupportedRuntimeCapabilityError) {
            orchestrator.failRun(run.id, error.message);
            break;
          }
          throw error;
        }
        await flush(task, run);
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    const aborted = deps.signal?.aborted === true;
    const cancellable =
      run.state === "pending" ||
      run.state === "running" ||
      run.state === "verifying" ||
      run.state === "reviewing";
    if (aborted && cancellable) {
      orchestrator.cancelRun(run.id, "cancelled by user");
      out("\n■ cancelled by user\n");
    } else if (cancellable) {
      orchestrator.failRun(run.id, message);
      out(`\nerror: ${message}\n`);
    } else {
      out(`\nerror: ${message}\n`);
    }
  }

  await flush(task, run);
  out("\n-- summary --\n");
  out(`State:     ${run.state.toUpperCase()}\n`);
  out(`Task:      ${task.title}\n`);
  if (brief.source.kind === "file") {
    out(`Brief:     ${brief.source.path}\n`);
  }
  out(`Workflow:  ${options.workflow}\n`);
  out(`Run:       ${run.id}\n`);
  out(`Invokes:   ${(run.invocations ?? []).length}\n`);
  out(`Branch:    ${run.branch ?? "-"}\n`);
  out(`Worktree:  ${run.workspacePath ?? "-"}\n`);
  if (run.result?.summary !== undefined) {
    out(`Result:    ${run.result.summary}\n`);
  }
  if (run.result?.error !== undefined) {
    out(`Error:     ${run.result.error}\n`);
  }
  const latestVerification = session.lastVerification();
  if (latestVerification !== undefined) {
    out(`Verify:    ${latestVerification.passed ? "passed" : "FAILED"}\n`);
  }
  if (run.review !== undefined) {
    out(
      `Review:    ${
        run.review.error !== undefined
          ? `unavailable (advisory): ${run.review.error}`
          : findingsSummary(run.review.findings)
      }\n`,
    );
  }
  const metadataPath = path.join(store.dir, `${run.id}.json`);
  out(`Metadata:  ${metadataPath} (+ .events.jsonl)\n`);

  const cleanupNote = await session.cleanup(run, options.cleanup);
  out(`Cleanup:   ${cleanupNote}\n`);

  const result: RunTaskResult = {
    exitCode: run.state === "completed" ? 0 : 1,
    run,
    task,
    repoRoot,
    storeDir: store.dir,
    cleanupNote,
  };
  if (latestVerification !== undefined) {
    result.verification = latestVerification;
  }
  return result;
}

interface PreflightInput {
  runtimeRegistry: RuntimeRegistry;
  driverTarget: ExecutionTarget;
  driverReasoningEffort?: ReasoningEffort;
  workerTargets: readonly WorkerTargetInput[];
  criticTarget: ExecutionTarget;
  criticReasoningEffort?: ReasoningEffort;
}

type PreflightResult =
  { ok: true; workerTargets: DriverTargetOption[] } | { ok: false; message: string };

async function preflightQualityTargets(input: PreflightInput): Promise<PreflightResult> {
  const workerTargets: DriverTargetOption[] = [];
  const seenIds = new Set<string>();
  for (const entry of input.workerTargets) {
    if (seenIds.has(entry.id)) {
      return { ok: false, message: `error: duplicate worker target id "${entry.id}"` };
    }
    seenIds.add(entry.id);
    const adapter = input.runtimeRegistry.get(entry.target.runtime);
    if (!adapter) {
      return { ok: false, message: unknownRuntime(entry.target.runtime, input.runtimeRegistry) };
    }
    workerTargets.push({
      id: entry.id,
      target: entry.target,
      capabilities: adapter.capabilities(),
    });
  }

  const driverRequirements = {
    label: "driver",
    readOnly: true,
    structuredOutput: true,
  };
  const driver = validateTarget(
    input.runtimeRegistry,
    input.driverTarget,
    input.driverReasoningEffort !== undefined
      ? { ...driverRequirements, explicitEffort: input.driverReasoningEffort }
      : driverRequirements,
  );
  if (driver !== undefined) {
    return { ok: false, message: driver };
  }
  const criticRequirements = {
    label: "critic",
    readOnly: true,
    structuredOutput: true,
  };
  const critic = validateTarget(
    input.runtimeRegistry,
    input.criticTarget,
    input.criticReasoningEffort !== undefined
      ? { ...criticRequirements, explicitEffort: input.criticReasoningEffort }
      : criticRequirements,
  );
  if (critic !== undefined) {
    return { ok: false, message: critic };
  }

  const targetsToDetect = new Map<string, ExecutionTarget>();
  targetsToDetect.set(input.driverTarget.runtime, input.driverTarget);
  targetsToDetect.set(input.criticTarget.runtime, input.criticTarget);
  for (const entry of input.workerTargets) {
    targetsToDetect.set(entry.target.runtime, entry.target);
  }
  for (const target of targetsToDetect.values()) {
    const adapter = input.runtimeRegistry.get(target.runtime);
    if (adapter === undefined) {
      return { ok: false, message: unknownRuntime(target.runtime, input.runtimeRegistry) };
    }
    const availability = await adapter.detect();
    if (!availability.available) {
      return {
        ok: false,
        message:
          `error: agent runtime "${adapter.id}" is not available: ` +
          `${availability.reason ?? "unknown reason"}`,
      };
    }
  }
  return { ok: true, workerTargets };
}

function validateTarget(
  registry: RuntimeRegistry,
  target: ExecutionTarget,
  requirements: {
    label: string;
    readOnly?: boolean;
    structuredOutput?: boolean;
    explicitEffort?: ReasoningEffort;
  },
): string | undefined {
  const adapter = registry.get(target.runtime);
  if (!adapter) {
    return unknownRuntime(target.runtime, registry);
  }
  const capabilities = adapter.capabilities();
  if (requirements.readOnly === true && !capabilities.readOnly) {
    return `error: ${requirements.label} runtime "${adapter.id}" does not support read-only execution`;
  }
  if (requirements.structuredOutput === true && !capabilities.structuredOutput) {
    return `error: ${requirements.label} runtime "${adapter.id}" does not support structured output`;
  }
  if (
    requirements.explicitEffort !== undefined &&
    !capabilities.reasoningEffort.includes(requirements.explicitEffort)
  ) {
    return (
      `error: ${requirements.label} runtime "${adapter.id}" does not support reasoning effort ` +
      `"${requirements.explicitEffort}" (supported: ${capabilities.reasoningEffort.join(", ") || "none"})`
    );
  }
  return undefined;
}

function normalizeWorkerTargets(
  configured: readonly WorkerTargetInput[] | undefined,
  fallback: ExecutionTarget,
): readonly WorkerTargetInput[] {
  return configured ?? [{ id: DEFAULT_DRIVER_TARGET_ID, target: fallback }];
}

function unknownRuntime(runtime: string, registry: RuntimeRegistry): string {
  return `error: unknown agent runtime "${runtime}" (available: ${registry.ids().join(", ") || "none"})`;
}

async function getDiff(run: Run): Promise<string> {
  return run.workspacePath === undefined ? "" : await getWorktreeDiff(run.workspacePath);
}

function progressFacts(
  run: Run,
  allowedWorkerTargets: readonly DriverTargetOption[],
  diff: string,
): DriverProgressFacts {
  const writableInvocations = (run.invocations ?? []).filter(
    (invocation) => invocation.role === "worker" && invocation.readOnly !== true,
  );
  const lastWorker = writableInvocations.at(-1);
  const repeatedFailureSignatureCount = consecutiveRepeatedFailureSignatureCount(
    run.verificationHistory ?? [],
  );
  const lastWorkerTarget = allowedWorkerTargets.find(
    (entry) =>
      lastWorker?.target.runtime === entry.target.runtime &&
      lastWorker.target.model === entry.target.model,
  );
  return {
    driverDecisionCount: run.driverDecisions?.length ?? 0,
    writableInvocationCount: writableInvocations.length,
    repeatedFailureSignatureCount,
    ...(lastWorkerTarget !== undefined ? { lastWorkerTargetId: lastWorkerTarget.id } : {}),
    ...(lastWorker?.reasoningEffort !== undefined
      ? { lastWorkerEffort: lastWorker.reasoningEffort }
      : {}),
    ...(lastWorker?.workspaceChange !== undefined
      ? { lastWorkerChangedWorkspace: lastWorker.workspaceChange.changed }
      : {}),
    worktreeChanged: diff.trim().length > 0,
  };
}

function recordWorkspaceChange(
  invocation: NonNullable<Run["invocations"]>[number],
  beforeDiff: string,
  afterDiff: string,
): void {
  const beforeFingerprint = diffFingerprint(beforeDiff);
  const afterFingerprint = diffFingerprint(afterDiff);
  invocation.workspaceChange = {
    beforeFingerprint,
    afterFingerprint,
    changed: beforeFingerprint !== afterFingerprint,
  };
}

function diffFingerprint(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

function consecutiveRepeatedFailureSignatureCount(
  history: NonNullable<Run["verificationHistory"]>,
): number {
  const latest = history.at(-1)?.failureSignature;
  if (latest === undefined || latest === "passed") {
    return 0;
  }
  let count = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.failureSignature !== latest) {
      break;
    }
    count++;
  }
  return count;
}

function verificationIsFresh(run: Run): boolean {
  return acceptRefusalReason(run) === undefined;
}

function acceptRefusalReason(run: Run): string | undefined {
  const latest = run.verificationHistory?.at(-1);
  if (latest === undefined) {
    return "verification is missing";
  }
  if (!latest.outcome.passed) {
    return "verification is red";
  }
  const lastWritable = lastWritableInvocation(run);
  if (latest.afterInvocationId !== lastWritable?.id) {
    return "verification is stale";
  }
  return undefined;
}

function lastWritableInvocation(run: Run): NonNullable<Run["invocations"]>[number] | undefined {
  return [...(run.invocations ?? [])]
    .reverse()
    .find((invocation) => invocation.role === "worker" && invocation.readOnly !== true);
}
