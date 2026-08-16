import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useSyncExternalStore } from "react";

import type { ReviewFinding } from "../../core/index.js";
import { findingsSummary } from "../format.js";

import type { ChecklistStep, RunModel, VerifyItem } from "./run-model.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "┴", "⦦", "⦧", "⦇", "⦏"];
const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_COLUMNS = 80;
/** Lines reserved for info box, checklist, pane label and footer. */
const CHROME_LINES = 16;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function shortId(runId: string): string {
  return runId.length > 0 ? runId.slice(0, 8) : "……";
}

/** Dim key, bright value — the Daytona key-value row. */
function Kv({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>{k.padEnd(10)}</Text>
      {v}
    </Text>
  );
}

function StepIcon({ status, spinner }: { status: ChecklistStep["status"]; spinner: string }) {
  switch (status) {
    case "done":
      return <Text color="green">✓</Text>;
    case "failed":
      return <Text color="red">✗</Text>;
    case "active":
      return <Text>{spinner}</Text>;
    case "pending":
      return <Text dimColor>•</Text>;
  }
}

function StepRow({
  step,
  spinner,
  width,
}: {
  step: ChecklistStep;
  spinner: string;
  width: number;
}) {
  return (
    <Box width={width} justifyContent="space-between">
      <Text dimColor={step.status === "pending"}>
        <StepIcon status={step.status} spinner={spinner} /> {step.label}
      </Text>
      {step.detail !== undefined && <Text dimColor>{step.detail}</Text>}
    </Box>
  );
}

function VerifyItemRow({ item, spinner }: { item: VerifyItem; spinner: string }) {
  switch (item.status) {
    case "pending":
      return (
        <Text dimColor>
          {"   "}• {item.name}
        </Text>
      );
    case "running":
      return (
        <Text>
          {"   "}
          {spinner} {item.name}
        </Text>
      );
    case "passed":
      return (
        <Text>
          {"   "}
          <Text color="green">✓</Text> {item.name}
          <Text dimColor> {((item.durationMs ?? 0) / 1000).toFixed(1)}s</Text>
        </Text>
      );
    case "failed":
    case "timed-out":
      return (
        <Box flexDirection="column">
          <Text>
            {"   "}
            <Text color="red">✗</Text> {item.name}
            <Text dimColor>
              {" "}
              {item.status === "timed-out" ? "timed out" : `exit ${item.exitCode ?? "null"}`}
            </Text>
          </Text>
          {item.stderrTail?.map((line, index) => (
            <Text key={index} dimColor>
              {"     "}⎿ {line}
            </Text>
          ))}
        </Box>
      );
  }
}

function InfoBox({ model, width }: { model: RunModel; width: number }) {
  const verifyNames =
    model.verifyItems.length > 0 ? model.verifyItems.map((item) => item.name).join(" · ") : "none";
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Kv k="Task" v={truncate(model.taskTitle, width - 20)} />
      {model.briefPath.length > 0 && <Kv k="Brief" v={truncate(model.briefPath, width - 20)} />}
      {model.workflow.length > 0 && <Kv k="Workflow" v={model.workflow} />}
      <Kv k="Run" v={shortId(model.runId)} />
      <Kv k="Branch" v={model.branch} />
      <Kv k="Worktree" v={model.worktreePath} />
      <Kv k="Verify" v={verifyNames} />
    </Box>
  );
}

function SeverityTag({ severity }: { severity: ReviewFinding["severity"] }) {
  if (severity === "critical") {
    return <Text color="red">[critical]</Text>;
  }
  if (severity === "major") {
    return <Text color="yellow">[major]</Text>;
  }
  return <Text dimColor>[{severity}]</Text>;
}

const MAX_RENDERED_FINDINGS = 5;

function FinalBox({ model, width }: { model: RunModel; width: number }) {
  const result = model.final;
  const state = model.finalState ?? "setup-error";
  const stateNode =
    state === "completed" ? (
      <Text color="green">✓ COMPLETED</Text>
    ) : state === "cancelled" ? (
      <Text color="yellow">■ CANCELLED</Text>
    ) : (
      <Text color="red">✗ FAILED</Text>
    );

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Kv k="State" v={stateNode} />
      {result?.run !== undefined && result.run.attempts.length > 0 && (
        <Kv
          k="Attempts"
          v={`${result.run.attempts.length}${result.run.attempts.length > 1 ? " (initial + correction)" : ""}`}
        />
      )}
      {result?.run?.branch !== undefined && <Kv k="Branch" v={result.run.branch} />}
      {result?.run?.workspacePath !== undefined && <Kv k="Worktree" v={result.run.workspacePath} />}
      {result?.run?.result?.error !== undefined && (
        <Kv k="Error" v={<Text color="red">{result.run.result.error}</Text>} />
      )}
      {result?.verification !== undefined &&
        (result.verification.results.length === 0 ? (
          <Kv k="Verify" v={<Text dimColor>no verification commands configured</Text>} />
        ) : (
          <Kv
            k="Verify"
            v={`${result.verification.passed ? "passed" : "FAILED"} (${result.verification.results
              .map((r) => `${r.name} ${r.timedOut ? "timeout" : r.exitCode === 0 ? "✓" : "✗"}`)
              .join(", ")})`}
          />
        ))}
      {result !== undefined && result.run !== undefined && (
        <Kv k="Metadata" v={`${result.storeDir}/${result.run.id}.json`} />
      )}
      {result?.run?.review !== undefined &&
        (result.run.review.error !== undefined ? (
          <Kv k="Review" v={<Text dimColor>unavailable (advisory)</Text>} />
        ) : (
          <>
            <Kv k="Review" v={findingsSummary(result.run.review.findings)} />
            {result.run.review.findings.slice(0, MAX_RENDERED_FINDINGS).map((finding, index) => (
              <Text key={index}>
                {"  "}• <SeverityTag severity={finding.severity} />{" "}
                {finding.path !== undefined ? `${finding.path}: ` : ""}
                {finding.message}
              </Text>
            ))}
            {result.run.review.findings.length > MAX_RENDERED_FINDINGS && (
              <Text dimColor>
                {"  "}… +{result.run.review.findings.length - MAX_RENDERED_FINDINGS} more in the run
                JSON
              </Text>
            )}
          </>
        ))}
      {result?.cleanupNote !== undefined && <Kv k="Cleanup" v={result.cleanupNote} />}
    </Box>
  );
}

export interface RunAppProps {
  model: RunModel;
  /** q / Ctrl-C while running: graceful cancel through the AbortSignal. */
  onCancel: () => void;
  /** q / enter / Ctrl-C on the final panel: dismiss and exit. */
  onQuit: () => void;
  /** Output pane height; defaults to terminal rows minus chrome. */
  viewportHeight?: number;
  /** Content width; defaults to terminal columns (capped). */
  width?: number;
}

export function RunApp({
  model,
  onCancel,
  onQuit,
  viewportHeight,
  width,
}: RunAppProps): React.JSX.Element {
  useSyncExternalStore(model.subscribe, model.getVersion);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 150);
    return () => clearInterval(interval);
  }, []);

  const contentWidth =
    width ?? Math.min(76, (process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS) - 2);
  const height =
    viewportHeight ?? Math.max(4, (process.stdout.rows ?? DEFAULT_TERMINAL_ROWS) - CHROME_LINES);
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⠋";
  const done = model.phase === "done";

  useInput((input, key) => {
    if (key.upArrow) {
      model.scrollUp(1);
    } else if (key.downArrow) {
      model.scrollDown(1);
    } else if (key.pageUp) {
      model.scrollUp(height);
    } else if (key.pageDown) {
      model.scrollDown(height);
    } else if (input === "q" || (key.ctrl && input === "c")) {
      if (done) {
        onQuit();
      } else {
        onCancel();
      }
    } else if (key.return && done) {
      onQuit();
    }
  });

  const visible = model.visibleLines(height);
  const blankLines = Math.max(0, height - visible.length);

  return (
    <Box flexDirection="column">
      {model.contextReady && <InfoBox model={model} width={contentWidth} />}
      <Text> </Text>
      {model.steps.map((step) => (
        <Box key={step.id} flexDirection="column">
          <StepRow step={step} spinner={spinner} width={contentWidth} />
          {step.id === model.currentVerifyStepId &&
            model.verifyItems.map((item) => (
              <VerifyItemRow key={item.name} item={item} spinner={spinner} />
            ))}
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>
        {"──"} agent output
        {model.follow ? "" : ` (scrolled ${model.scrollOffset} ↑ — ↓ to end resumes)`}
        {model.truncatedLines > 0 ? ` · ${model.truncatedLines} earlier lines dropped` : ""}
        {" ──"}
      </Text>
      <Box flexDirection="column" height={height}>
        {visible.map((line, index) => (
          <Text key={index} dimColor={line.stream !== "stdout"}>
            {line.text}
          </Text>
        ))}
        {Array.from({ length: blankLines }, (_, index) => (
          <Text key={`blank-${index}`}> </Text>
        ))}
      </Box>
      <Text> </Text>
      {done && <FinalBox model={model} width={contentWidth} />}
      <Text dimColor>
        {done
          ? "q / enter: exit"
          : `elapsed ${formatElapsed(model.startedAt, Date.now())} · q / Ctrl-C: cancel · ↑/↓: scroll`}
      </Text>
    </Box>
  );
}
