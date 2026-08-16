import { CodexAdapter } from "../adapters/codex/index.js";
import { ClaudeAdapter } from "../adapters/claude/index.js";
import type {
  AgentAdapter,
  ExecutionTarget,
  ReasoningEffort,
  RuntimeRegistry,
  WorkflowName,
} from "../core/index.js";
import {
  DEFAULT_WORKFLOW,
  isWorkflowName,
  StaticRuntimeRegistry,
  WORKFLOW_NAMES,
  WORKFLOWS,
} from "../core/index.js";
import type { VerificationCommand } from "../verification/index.js";

import { parseArgs, UsageError } from "./args.js";
import { BriefError, resolveBrief } from "./brief.js";
import { doctorCommand } from "./doctor-command.js";
import { runTask } from "./run-command.js";
import { statusCommand } from "./status-command.js";

const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_RUNTIME = "codex-cli";
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "maximum",
];

const USAGE = `conjunction — orchestration runtime for coding agents

usage:
  conjunction run "<task>" | <brief.md> | --brief <file>
                           [--workflow ${WORKFLOW_NAMES.join("|")}]
                           [--repo <path>] [--verify "<cmd> [args...]"]...
                           [--runtime <id>] [--model <model>] [--effort <level>]
                           [--critic-runtime <id>] [--critic-model <model>]
                           [--critic-effort <level>]
                           [--timeout <minutes>] [--cleanup]
                           [--plain] [--no-correct] [--review]
  conjunction land <runId> [--repo <path>] [--branch <target>] [--cleanup]
  conjunction status [--repo <path>]
  conjunction doctor

commands:
  run      execute a brief in an isolated git worktree via a selected runtime
  land     apply a completed run's changes onto your branch (uncommitted)
  status   list runs recorded under .conjunction/runs/
  doctor   check that the agent runtime (codex cli) is available

workflows (--workflow, default: ${DEFAULT_WORKFLOW}):
${WORKFLOW_NAMES.map((name) => `  ${name.padEnd(8)} ${WORKFLOWS[name].description}`).join("\n")}

notes:
  a lone positional is read as a brief FILE when it looks like a path
  (./x, ../x, /x, ~/x, or *.md/*.markdown/*.txt); otherwise it is the task
  text. --brief <file> is the explicit form and never guesses.
  --verify splits on whitespace; quote the whole command, not its arguments.
  failed verification triggers ONE correction attempt (same worker, bounded
  packet) then a re-check; --no-correct disables it. No --verify, no correction.
  Correction belongs to every workflow — it is the worker responding to
  deterministic feedback, not a separate role.
  --review is an alias for --workflow review (independent READ-ONLY critic
  after verification passes); findings are advisory and never change the exit code.
  --runtime defaults to ${DEFAULT_RUNTIME}; --critic-runtime defaults to the worker runtime.
  reasoning effort values: ${REASONING_EFFORTS.join("|")}.
  worktrees are preserved by default; --cleanup only removes a CLEAN worktree.
  an interactive TUI renders when stdout is a terminal; --plain forces text.
  Ctrl-C cancels the agent gracefully (a second Ctrl-C force-exits).
`;

export interface CliDeps {
  /** Adapter injection seam for tests; defaults to the real Codex CLI. */
  adapter?: AgentAdapter;
  runtimeRegistry?: RuntimeRegistry;
  out?: (chunk: string) => void;
}

export async function cli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out =
    deps.out ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "run": {
        const parsed = parseArgs(rest, {
          valueOptions: [
            "repo",
            "verify",
            "timeout",
            "model",
            "brief",
            "workflow",
            "runtime",
            "critic-runtime",
            "critic-model",
            "effort",
            "critic-effort",
          ],
          flags: ["cleanup", "help", "plain", "no-correct", "review"],
        });
        if (parsed.flags.has("help")) {
          out(USAGE);
          return 0;
        }
        const workflow = resolveWorkflowOption(
          parsed.options.workflow?.at(-1),
          parsed.flags.has("review"),
        );
        const briefOption = parsed.options.brief?.at(-1);
        const brief = await resolveBrief(
          {
            positionals: parsed.positionals,
            ...(briefOption !== undefined ? { briefOption } : {}),
          },
          process.cwd(),
        );
        const timeoutMinutes = parseTimeout(parsed.options.timeout?.at(-1));
        const runtimeRegistry = resolveRuntimeRegistry(deps);
        const defaultRuntime = deps.adapter?.id ?? DEFAULT_RUNTIME;
        const verifyCommands = (parsed.options.verify ?? []).map(parseVerifyCommand);
        const workerTarget = buildTarget(
          parsed.options.runtime?.at(-1) ?? defaultRuntime,
          parsed.options.model?.at(-1),
        );
        const criticRuntime = parsed.options["critic-runtime"]?.at(-1);
        const criticModel = parsed.options["critic-model"]?.at(-1);
        const criticTarget =
          criticRuntime !== undefined || criticModel !== undefined
            ? buildTarget(criticRuntime ?? workerTarget.runtime, criticModel)
            : undefined;
        const workerReasoningEffort = parseReasoningEffort(parsed.options.effort?.at(-1));
        const criticReasoningEffort = parseReasoningEffort(parsed.options["critic-effort"]?.at(-1));
        const runOptions = {
          brief,
          workflow,
          workerTarget,
          ...(workerReasoningEffort !== undefined ? { workerReasoningEffort } : {}),
          ...(criticTarget !== undefined ? { criticTarget } : {}),
          ...(criticReasoningEffort !== undefined ? { criticReasoningEffort } : {}),
          repoPath: parsed.options.repo?.at(-1) ?? process.cwd(),
          verifyCommands,
          timeoutMinutes,
          cleanup: parsed.flags.has("cleanup"),
          // correction only makes sense with something to correct against
          correct: verifyCommands.length > 0 && !parsed.flags.has("no-correct"),
        };

        // The TUI only takes over a real terminal the user is watching; tests
        // (injected `out`), pipes and CI get the plain output, as does --plain.
        const useTui =
          !parsed.flags.has("plain") && deps.out === undefined && process.stdout.isTTY === true;
        if (useTui) {
          const { runWithTui } = await import("./ui/tui.js");
          return await runWithTui(runOptions, { runtimeRegistry });
        }

        // Plain mode: first Ctrl-C cancels the run gracefully through the
        // AbortSignal; a second one force-exits.
        const controller = new AbortController();
        const onSigint = (): void => {
          if (controller.signal.aborted) {
            process.exit(130);
          }
          controller.abort();
        };
        process.on("SIGINT", onSigint);
        try {
          const result = await runTask(runOptions, {
            runtimeRegistry,
            out,
            signal: controller.signal,
          });
          return result.exitCode;
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      }
      case "land": {
        const parsed = parseArgs(rest, {
          valueOptions: ["repo", "branch"],
          flags: ["cleanup", "help"],
        });
        if (parsed.flags.has("help")) {
          out(USAGE);
          return 0;
        }
        const runId = parsed.positionals[0];
        if (runId === undefined) {
          throw new UsageError("land requires a run id (see: conjunction status)");
        }
        const branch = parsed.options.branch?.at(-1);
        const { landCommand } = await import("./land-command.js");
        return await landCommand(
          {
            runId,
            repoPath: parsed.options.repo?.at(-1) ?? process.cwd(),
            cleanup: parsed.flags.has("cleanup"),
            ...(branch !== undefined ? { branch } : {}),
          },
          { out },
        );
      }
      case "status": {
        const parsed = parseArgs(rest, { valueOptions: ["repo"], flags: ["help"] });
        if (parsed.flags.has("help")) {
          out(USAGE);
          return 0;
        }
        return await statusCommand(parsed.options.repo?.at(-1) ?? process.cwd(), out);
      }
      case "doctor": {
        const parsed = parseArgs(rest, { valueOptions: ["runtime"], flags: ["help"] });
        const runtime = parsed.options.runtime?.at(-1) ?? deps.adapter?.id ?? DEFAULT_RUNTIME;
        const adapter = resolveRuntimeRegistry(deps).get(runtime);
        if (!adapter) {
          out(`error: unknown agent runtime "${runtime}"\n`);
          return 2;
        }
        return await doctorCommand(adapter, out);
      }
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return 0;
      case undefined:
        out(USAGE);
        return 2;
      default:
        out(`error: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      out(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    // A bad brief is a setup error like "not a git repository": exit 2, and
    // without the usage dump, which would bury the actual filesystem problem.
    if (error instanceof BriefError) {
      out(`error: ${error.message}\n`);
      return 2;
    }
    out(`error: ${(error as Error).message}\n`);
    return 1;
  }
}

function resolveRuntimeRegistry(deps: CliDeps): RuntimeRegistry {
  if (deps.runtimeRegistry !== undefined) {
    return deps.runtimeRegistry;
  }
  if (deps.adapter !== undefined) {
    return new StaticRuntimeRegistry([deps.adapter]);
  }
  return new StaticRuntimeRegistry([new CodexAdapter(), new ClaudeAdapter()]);
}

function buildTarget(runtime: string, model: string | undefined): ExecutionTarget {
  return model === undefined ? { runtime } : { runtime, model };
}

/**
 * `--workflow <name>`, with `--review` kept as an alias for `--workflow review`.
 * Disagreement between the two is an error rather than a silent precedence
 * rule (see docs/brief-workflow-design.md §5.3).
 */
function resolveWorkflowOption(raw: string | undefined, reviewFlag: boolean): WorkflowName {
  if (raw === undefined) {
    return reviewFlag ? "review" : DEFAULT_WORKFLOW;
  }
  if (!isWorkflowName(raw)) {
    throw new UsageError(`unknown workflow "${raw}" (available: ${WORKFLOW_NAMES.join(", ")})`);
  }
  if (reviewFlag && raw !== "review") {
    throw new UsageError(
      `--review contradicts --workflow ${raw}; --review is an alias for --workflow review`,
    );
  }
  return raw;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MINUTES;
  }
  const minutes = Number.parseFloat(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new UsageError(`invalid --timeout value: "${raw}" (expected positive minutes)`);
  }
  return minutes;
}

function parseReasoningEffort(raw: string | undefined): ReasoningEffort | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if ((REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return raw as ReasoningEffort;
  }
  throw new UsageError(
    `invalid reasoning effort "${raw}" (expected: ${REASONING_EFFORTS.join(", ")})`,
  );
}

function parseVerifyCommand(raw: string): VerificationCommand {
  const [command, ...args] = raw.trim().split(/\s+/).filter(Boolean);
  if (command === undefined) {
    throw new UsageError("empty --verify command");
  }
  return { name: raw, command, args };
}
