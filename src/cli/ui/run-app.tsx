import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useSyncExternalStore } from "react";

import type { RunModel, VerifyItem } from "./run-model.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "┴", "⦦", "⦧", "⦇", "⦏"];
const DEFAULT_TERMINAL_ROWS = 24;
/** Header + section chrome lines not available to the output pane. */
const CHROME_LINES = 8;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function phaseLabel(model: RunModel): string {
  switch (model.phase) {
    case "setup":
      return "STARTING (workspace)";
    case "agent":
      return "RUNNING (agent)";
    case "verification":
      return "VERIFYING";
    case "done":
      return (model.finalState ?? "unknown").toUpperCase();
  }
}

function shortId(runId: string): string {
  return runId.length > 0 ? runId.slice(0, 8) : "……";
}

function VerifyLine({ item, spinner }: { item: VerifyItem; spinner: string }): React.JSX.Element {
  let status: React.JSX.Element;
  switch (item.status) {
    case "pending":
      status = <Text dimColor>pending</Text>;
      break;
    case "running":
      status = <Text> {spinner} running</Text>;
      break;
    case "passed":
      status = <Text color="green"> ✓ {((item.durationMs ?? 0) / 1000).toFixed(1)}s</Text>;
      break;
    case "failed":
      status = <Text color="red"> ✗ exit {item.exitCode ?? "null"}</Text>;
      break;
    case "timed-out":
      status = <Text color="red"> ✗ timed out</Text>;
      break;
  }
  return (
    <Box flexDirection="column">
      <Text>
        {"│ "}● {item.name}
        {status}
      </Text>
      {item.stderrTail?.map((line, index) => (
        <Text key={index} dimColor>
          {"│   "}⎿ {line}
        </Text>
      ))}
    </Box>
  );
}

function FinalPanel({ model }: { model: RunModel }): React.JSX.Element {
  const result = model.final;
  const state = model.finalState ?? "setup-error";
  const headline =
    state === "completed" ? (
      <Text color="green">✓ COMPLETED</Text>
    ) : state === "cancelled" ? (
      <Text color="yellow">■ CANCELLED</Text>
    ) : (
      <Text color="red">✗ FAILED</Text>
    );

  return (
    <Box flexDirection="column">
      <Text>{"├"} Result</Text>
      <Text>
        {"│ "} {headline}
      </Text>
      {result?.run?.branch !== undefined && (
        <Text>
          {"│ "} branch: {result.run?.branch}
        </Text>
      )}
      {result?.run?.workspacePath !== undefined && (
        <Text>
          {"│ "} worktree: {result.run?.workspacePath}
        </Text>
      )}
      {result?.run?.result?.error !== undefined && (
        <Text color="red">
          {"│ "} error: {result.run.result.error}
        </Text>
      )}
      {result?.verification !== undefined &&
        (result.verification.results.length === 0 ? (
          <Text dimColor>{"│ "} verify: no verification commands configured</Text>
        ) : (
          <Text>
            {"│ "} verify: {result.verification.passed ? "passed" : "FAILED"} (
            {result.verification.results
              .map((r) => `${r.name} ${r.timedOut ? "timeout" : r.exitCode === 0 ? "✓" : "✗"}`)
              .join(", ")}
            )
          </Text>
        ))}
      {result !== undefined && result.run !== undefined && (
        <Text dimColor>
          {"│ "} metadata: {result.storeDir}/{result.run.id}.json (+ .events.jsonl)
        </Text>
      )}
      {result?.cleanupNote !== undefined && (
        <Text dimColor>
          {"│ "} {result.cleanupNote.trim()}
        </Text>
      )}
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
}

export function RunApp({
  model,
  onCancel,
  onQuit,
  viewportHeight,
}: RunAppProps): React.JSX.Element {
  useSyncExternalStore(model.subscribe, model.getVersion);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 150);
    return () => clearInterval(interval);
  }, []);

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

  return (
    <Box flexDirection="column">
      <Text>
        {"┌"} Conjunction ─ run {shortId(model.runId)} ─ task: "{truncate(model.taskTitle, 48)}"
      </Text>
      <Text>
        {"│"} state: {phaseLabel(model)}
        {"   "}elapsed {formatElapsed(model.startedAt, Date.now())}
        {model.branch.length > 0 ? `   branch ${model.branch}` : ""}
      </Text>
      <Text>
        {"├"} Agent output{" "}
        {model.follow ? "(autoscroll)" : `(scrolled ${model.scrollOffset} ↑ — ↓ to end resumes)`}
        {model.truncatedLines > 0 ? ` · ${model.truncatedLines} earlier lines dropped` : ""}
      </Text>
      <Box flexDirection="column" height={height}>
        {visible.map((line, index) => (
          <Text key={index} dimColor={line.stream !== "stdout"}>
            {"│ "}
            {line.text}
          </Text>
        ))}
      </Box>
      <Text>{"├"} Verification</Text>
      {model.verifyItems.length === 0 ? (
        <Text dimColor>{"│ "}(no verification commands configured)</Text>
      ) : (
        model.verifyItems.map((item) => (
          <VerifyLine key={item.name} item={item} spinner={spinner} />
        ))
      )}
      {done && <FinalPanel model={model} />}
      <Text>
        {"└"} {done ? "q / enter: exit" : "q / Ctrl-C: cancel run · ↑/↓: scroll"}
      </Text>
    </Box>
  );
}
