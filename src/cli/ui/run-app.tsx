import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useSyncExternalStore } from "react";

import type { ReviewFinding } from "../../core/index.js";
import { findingsSummary } from "../format.js";

import type { ChecklistStep, RunModel, StepDecision, VerifyItem } from "./run-model.js";

// Single-width quarter-turn frames: stable width, no character shifting the
// following text between ticks. Only the active step uses it.
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const DEFAULT_TERMINAL_COLUMNS = 80;
/** Cap on the live agent-output pane so a long run cannot eat the whole screen. */
const MAX_OUTPUT_PANE = 8;

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Dim key, bright value — the key-value row. */
function Kv({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <Text wrap="wrap">
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
    case "cancelled":
      return <Text color="yellow">■</Text>;
    case "active":
      return <Text>{spinner}</Text>;
    case "pending":
      return <Text dimColor>•</Text>;
  }
}

function decisionVerb(action: string): string {
  switch (action) {
    case "delegate":
      return "Delegate";
    case "verify":
      return "Verify";
    case "accept":
      return "Accept";
    case "stop":
      return "Stop";
    default:
      return action;
  }
}

function DecisionLines({ decision }: { decision: StepDecision }): React.JSX.Element {
  const verb = decisionVerb(decision.action);
  const first =
    decision.action === "delegate" && decision.target !== undefined
      ? `→ ${verb} · ${decision.target}`
      : `→ ${verb}`;
  return (
    <Box flexDirection="column" marginLeft={3}>
      <Text wrap="wrap">{first}</Text>
      {decision.refused !== undefined && (
        <Text color="red" wrap="wrap">
          ✗ Refused · {decision.refused}
        </Text>
      )}
      <Text dimColor wrap="wrap">
        {decision.reason}
      </Text>
      {decision.objective !== undefined && (
        <Text dimColor wrap="wrap">
          {decision.objective}
        </Text>
      )}
    </Box>
  );
}

function StepRow({
  step,
  spinner,
  width,
  runtimeLabel,
  now,
}: {
  step: ChecklistStep;
  spinner: string;
  width: number;
  runtimeLabel: string;
  now: number;
}) {
  const isQuality = step.id.startsWith("driver-") || step.id.startsWith("worker-");
  const label =
    isQuality && runtimeLabel.length > 0 ? `${step.label} · ${runtimeLabel}` : step.label;
  const detail =
    step.status === "active" && step.startedAt !== undefined
      ? formatElapsed(step.startedAt, now)
      : step.detail;
  return (
    <Box width={width} justifyContent="space-between">
      <Text dimColor={step.status === "pending"} wrap="wrap">
        <StepIcon status={step.status} spinner={spinner} /> {label}
      </Text>
      {detail !== undefined && <Text dimColor>{detail}</Text>}
    </Box>
  );
}

function VerifyItemRow({ item, spinner }: { item: VerifyItem; spinner: string }) {
  switch (item.status) {
    case "pending":
      return (
        <Text dimColor wrap="wrap">
          {"   "}• {item.name}
        </Text>
      );
    case "running":
      return (
        <Text wrap="wrap">
          {"   "}
          {spinner} {item.name}
        </Text>
      );
    case "passed":
      return (
        <Text wrap="wrap">
          {"   "}
          <Text color="green">✓</Text> {item.name}
          <Text dimColor> {((item.durationMs ?? 0) / 1000).toFixed(1)}s</Text>
        </Text>
      );
    case "failed":
    case "timed-out":
      return (
        <Box flexDirection="column">
          <Text wrap="wrap">
            {"   "}
            <Text color="red">✗</Text> {item.name}
            <Text dimColor>
              {" "}
              {item.status === "timed-out" ? "timed out" : `exit ${item.exitCode ?? "null"}`}
            </Text>
          </Text>
          {item.stderrTail?.map((line, index) => (
            <Text key={index} dimColor wrap="wrap">
              {"     "}⎿ {line}
            </Text>
          ))}
        </Box>
      );
  }
}

function StepBlock({
  step,
  spinner,
  width,
  runtimeLabel,
  verifyItems,
  now,
}: {
  step: ChecklistStep;
  spinner: string;
  width: number;
  runtimeLabel: string;
  verifyItems: VerifyItem[];
  now: number;
}) {
  return (
    <Box flexDirection="column">
      <StepRow step={step} spinner={spinner} width={width} runtimeLabel={runtimeLabel} now={now} />
      {step.decision !== undefined && <DecisionLines decision={step.decision} />}
      {step.status === "active" && step.activity !== undefined && (
        <Text dimColor wrap="wrap">
          {"  "}◌ {step.activity}
        </Text>
      )}
      {verifyItems.map((item) => (
        <VerifyItemRow key={item.name} item={item} spinner={spinner} />
      ))}
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
    <Box flexDirection="column" width={width}>
      <Kv k="State" v={stateNode} />
      {state === "completed" && model.final?.run?.id !== undefined && (
        <Kv k="Next" v={<Text>conjunction land {model.final.run.id}</Text>} />
      )}
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
              <Text key={index} wrap="wrap">
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
    width ?? Math.max(40, Math.min(100, (process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS) - 2));
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "◐";
  const done = model.phase === "done";
  const now = Date.now();

  useInput((input, key) => {
    if (key.upArrow) {
      model.scrollUp(1);
    } else if (key.downArrow) {
      model.scrollDown(1);
    } else if (key.pageUp) {
      model.scrollUp(MAX_OUTPUT_PANE);
    } else if (key.pageDown) {
      model.scrollDown(MAX_OUTPUT_PANE);
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

  // The agent-output pane is deliberately compact and only appears when there
  // is actually something to show — no reserved empty viewport.
  const paneCap = Math.min(MAX_OUTPUT_PANE, viewportHeight ?? MAX_OUTPUT_PANE);
  const paneHeight = Math.min(paneCap, Math.max(1, model.lineCount));
  const hasOutput = model.lineCount > 0;
  const visible = hasOutput ? model.visibleLines(paneHeight) : [];

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text bold>Conjunction</Text>
      <Text dimColor>{"─".repeat(contentWidth)}</Text>
      {model.taskTitle.length > 0 && (
        <Text wrap="wrap" bold>
          {model.taskTitle}
        </Text>
      )}
      {model.shortBranch.length > 0 && (
        <Text dimColor wrap="wrap">
          workspace · isolated · {model.shortBranch}
        </Text>
      )}
      <Text> </Text>
      {model.steps.map((step) => (
        <StepBlock
          key={step.id}
          step={step}
          spinner={spinner}
          width={contentWidth}
          runtimeLabel={model.runtimeLabel}
          verifyItems={step.id === model.currentVerifyStepId ? model.verifyItems : []}
          now={now}
        />
      ))}
      <Text> </Text>
      {hasOutput && (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            {"──"} agent output
            {model.follow ? "" : ` (scrolled ${model.scrollOffset} ↑ — ↓ to end resumes)`}
            {model.truncatedLines > 0 ? ` · ${model.truncatedLines} earlier lines dropped` : ""}
            {" ──"}
          </Text>
          <Box flexDirection="column" height={paneHeight}>
            {visible.map((line, index) => (
              <Text key={index} dimColor={line.stream !== "stdout"} wrap="wrap">
                {line.text}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      <Text> </Text>
      {done && <FinalBox model={model} width={contentWidth} />}
      <Text dimColor>
        {done
          ? "q / enter: exit"
          : `elapsed ${formatElapsed(model.startedAt, now)} · q / Ctrl-C: cancel · ↑/↓: scroll`}
      </Text>
    </Box>
  );
}
