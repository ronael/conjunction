#!/usr/bin/env node
/* global console, process */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "dist", "cli", "main.js");
const repo = mkdtempSync(path.join(tmpdir(), "conjunction-live-eval-"));
const cleanup = process.env.CONJUNCTION_LIVE_KEEP_REPO === "1" ? false : true;

const workerRuntime = process.env.CONJUNCTION_LIVE_WORKER_RUNTIME ?? "codex-cli";
const workerModel = process.env.CONJUNCTION_LIVE_WORKER_MODEL;
const driverRuntime = process.env.CONJUNCTION_LIVE_DRIVER_RUNTIME ?? "claude-code";
const driverModel = process.env.CONJUNCTION_LIVE_DRIVER_MODEL;
const criticRuntime = process.env.CONJUNCTION_LIVE_CRITIC_RUNTIME ?? driverRuntime;
const criticModel = process.env.CONJUNCTION_LIVE_CRITIC_MODEL;
const observerRuntime = process.env.CONJUNCTION_LIVE_OBSERVER_RUNTIME ?? criticRuntime;
const observerModel = process.env.CONJUNCTION_LIVE_OBSERVER_MODEL;
const timeout = process.env.CONJUNCTION_LIVE_TIMEOUT_MINUTES ?? "5";
const maxInvocations = Number(process.env.CONJUNCTION_LIVE_MAX_INVOCATIONS ?? "8");
const maxCostUsd = optionalNumber(process.env.CONJUNCTION_LIVE_MAX_COST_USD);
const maxTokens = optionalNumber(process.env.CONJUNCTION_LIVE_MAX_TOKENS);

const brief = [
  "Create a file named live-eval-result.txt containing exactly:",
  "conjunction live eval ok",
  "",
  "Keep the change minimal. Do not modify README.md.",
].join("\n");

try {
  ensureBuilt();
  git(["init", "-b", "main"]);
  git(["config", "user.email", "live-eval@conjunction.dev"]);
  git(["config", "user.name", "Conjunction Live Eval"]);
  writeFileSync(path.join(repo, "README.md"), "# live eval\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial commit"]);
  const mainBefore = git(["rev-parse", "main"]).stdout.trim();

  const runArgs = [
    bin,
    "run",
    "--brief",
    path.join(repo, "BRIEF.md"),
    "--repo",
    repo,
    "--workflow",
    "quality",
    "--runtime",
    workerRuntime,
    "--driver-runtime",
    driverRuntime,
    "--critic-runtime",
    criticRuntime,
    "--observer-runtime",
    observerRuntime,
    "--verify",
    "test -f live-eval-result.txt",
    "--verify",
    "grep -q conjunction live-eval-result.txt",
    "--verify",
    "git diff -- README.md --exit-code",
    "--timeout",
    timeout,
    "--plain",
    "--no-correct",
  ];
  addOptional(runArgs, "--model", workerModel);
  addOptional(runArgs, "--driver-model", driverModel);
  addOptional(runArgs, "--critic-model", criticModel);
  addOptional(runArgs, "--observer-model", observerModel);
  writeFileSync(path.join(repo, "BRIEF.md"), brief);

  const started = Date.now();
  const run = node(runArgs.slice(1), { timeoutMs: Number(timeout) * 60_000 + 60_000 });
  const durationMs = Date.now() - started;
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) {
    throw new Error(`conjunction run failed with exit ${run.status}`);
  }

  const runId = extractRunId(run.stdout);
  const runJson = JSON.parse(
    readFileSync(path.join(repo, ".conjunction", "runs", `${runId}.json`), "utf8"),
  );
  const report = node(["report", runId, "--repo", repo, "--json"]);
  if (report.status !== 0) {
    process.stdout.write(report.stdout);
    process.stderr.write(report.stderr);
    throw new Error(`conjunction report failed with exit ${report.status}`);
  }
  const parsedReport = JSON.parse(report.stdout);

  assertEqual(git(["rev-parse", "main"]).stdout.trim(), mainBefore, "main branch changed");
  assertEqual(runJson.run.state, "completed", "run did not complete");
  assertEqual(parsedReport.verification.latestPassed, true, "verification did not pass");
  if (parsedReport.metrics.invocationCount > maxInvocations) {
    throw new Error(
      `invocation guard exceeded: ${parsedReport.metrics.invocationCount} > ${maxInvocations}`,
    );
  }
  if (maxCostUsd !== undefined && parsedReport.metrics.usage.costUsd !== null) {
    if (parsedReport.metrics.usage.costUsd > maxCostUsd) {
      throw new Error(`cost guard exceeded: ${parsedReport.metrics.usage.costUsd} > ${maxCostUsd}`);
    }
  }
  const knownTokens =
    (parsedReport.metrics.usage.inputTokens ?? 0) + (parsedReport.metrics.usage.outputTokens ?? 0);
  if (maxTokens !== undefined && knownTokens > maxTokens) {
    throw new Error(`token guard exceeded: ${knownTokens} > ${maxTokens}`);
  }

  const worktreePath = runJson.run.workspacePath;
  const resultText = readFileSync(path.join(worktreePath, "live-eval-result.txt"), "utf8");
  assertEqual(resultText, "conjunction live eval ok\n", "unexpected worktree file content");

  const summary = {
    runId,
    repo,
    durationMs,
    runtimes: {
      driver: targetLabel(driverRuntime, driverModel),
      worker: targetLabel(workerRuntime, workerModel),
      critic: targetLabel(criticRuntime, criticModel),
      observer: targetLabel(observerRuntime, observerModel),
    },
    invocations: parsedReport.metrics.invocationCount,
    verification: parsedReport.verification.latestPassed,
    observerFindings: parsedReport.observer?.findings ?? null,
    usage: parsedReport.metrics.usage,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (cleanup) {
    rmSync(repo, { recursive: true, force: true });
  } else {
    console.log(`kept live eval repo: ${repo}`);
  }
}

function ensureBuilt() {
  try {
    readFileSync(bin);
  } catch {
    throw new Error("dist/cli/main.js not found; run pnpm build before pnpm eval:live");
  }
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function node(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
}

function extractRunId(stdout) {
  const match = stdout.match(/^run:\s+(\S+)/m);
  if (match === null) {
    throw new Error("could not find run id in conjunction output");
  }
  return match[1];
}

function addOptional(args, flag, value) {
  if (value !== undefined && value.length > 0) {
    args.push(flag, value);
  }
}

function optionalNumber(value) {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric guard: ${value}`);
  }
  return parsed;
}

function targetLabel(runtime, model) {
  return model === undefined || model.length === 0 ? runtime : `${runtime}/${model}`;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
