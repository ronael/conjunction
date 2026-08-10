import { CodexAdapter } from "../adapters/codex/index.js";
import type { AgentAdapter } from "../core/index.js";
import type { VerificationCommand } from "../verification/index.js";

import { parseArgs, UsageError } from "./args.js";
import { doctorCommand } from "./doctor-command.js";
import { runTask } from "./run-command.js";
import { statusCommand } from "./status-command.js";

const DEFAULT_TIMEOUT_MINUTES = 10;

const USAGE = `conjunction — orchestration runtime for coding agents

usage:
  conjunction run "<task>" [--repo <path>] [--verify "<cmd> [args...]"]...
                           [--timeout <minutes>] [--model <model>] [--cleanup]
                           [--plain] [--no-correct] [--review]
  conjunction land <runId> [--repo <path>] [--branch <target>] [--cleanup]
  conjunction status [--repo <path>]
  conjunction doctor

commands:
  run      execute a task in an isolated git worktree via the codex adapter
  land     apply a completed run's changes onto your branch (uncommitted)
  status   list runs recorded under .conjunction/runs/
  doctor   check that the agent runtime (codex cli) is available

notes:
  --verify splits on whitespace; quote the whole command, not its arguments.
  failed verification triggers ONE correction attempt (same worker, bounded
  packet) then a re-check; --no-correct disables it. No --verify, no correction.
  --review runs an independent READ-ONLY reviewer after verification passes;
  findings are advisory and never change the exit code.
  worktrees are preserved by default; --cleanup only removes a CLEAN worktree.
  an interactive TUI renders when stdout is a terminal; --plain forces text.
  Ctrl-C cancels the agent gracefully (a second Ctrl-C force-exits).
`;

export interface CliDeps {
  /** Adapter injection seam for tests; defaults to the real Codex CLI. */
  adapter?: AgentAdapter;
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
          valueOptions: ["repo", "verify", "timeout", "model"],
          flags: ["cleanup", "help", "plain", "no-correct", "review"],
        });
        if (parsed.flags.has("help")) {
          out(USAGE);
          return 0;
        }
        const description = parsed.positionals.join(" ").trim();
        if (description.length === 0) {
          throw new UsageError("run requires a task description");
        }
        const timeoutMinutes = parseTimeout(parsed.options.timeout?.at(-1));
        const model = parsed.options.model?.at(-1);
        const adapter =
          deps.adapter ?? new CodexAdapter(model !== undefined ? { model } : undefined);
        const verifyCommands = (parsed.options.verify ?? []).map(parseVerifyCommand);
        const runOptions = {
          description,
          repoPath: parsed.options.repo?.at(-1) ?? process.cwd(),
          verifyCommands,
          timeoutMinutes,
          cleanup: parsed.flags.has("cleanup"),
          // correction only makes sense with something to correct against
          correct: verifyCommands.length > 0 && !parsed.flags.has("no-correct"),
          review: parsed.flags.has("review"),
        };

        // The TUI only takes over a real terminal the user is watching; tests
        // (injected `out`), pipes and CI get the plain output, as does --plain.
        const useTui =
          !parsed.flags.has("plain") && deps.out === undefined && process.stdout.isTTY === true;
        if (useTui) {
          const { runWithTui } = await import("./ui/tui.js");
          return await runWithTui(runOptions, { adapter });
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
          const result = await runTask(runOptions, { adapter, out, signal: controller.signal });
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
        parseArgs(rest, { valueOptions: [], flags: ["help"] });
        const adapter = deps.adapter ?? new CodexAdapter();
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
    out(`error: ${(error as Error).message}\n`);
    return 1;
  }
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

function parseVerifyCommand(raw: string): VerificationCommand {
  const [command, ...args] = raw.trim().split(/\s+/).filter(Boolean);
  if (command === undefined) {
    throw new UsageError("empty --verify command");
  }
  return { name: raw, command, args };
}
