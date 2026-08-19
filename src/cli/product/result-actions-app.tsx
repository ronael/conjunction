import { Box, Text, useInput } from "ink";
import React, { useSyncExternalStore } from "react";

import type { ResultActionsModel } from "./result-actions-model.js";

function Arrow({ active }: { active: boolean }): React.JSX.Element {
  return active ? <Text color="cyan">›</Text> : <Text> </Text>;
}

function Separator({ width }: { width: number }): React.JSX.Element {
  return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
}

export function ResultActionsApp({
  model,
  width,
  height,
  onExit,
}: {
  model: ResultActionsModel;
  width: number;
  height: number;
  onExit: () => void;
}): React.JSX.Element {
  useSyncExternalStore(model.subscribe, model.getVersion);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
      return;
    }
    switch (model.view) {
      case "actions":
        if (key.escape) onExit();
        else if (key.upArrow) model.move(-1);
        else if (key.downArrow) model.move(1);
        else if (key.return) void selectAction(model);
        break;
      case "diff":
        if (key.escape) model.back();
        else if (key.upArrow) model.scrollDiff(-1);
        else if (key.downArrow) model.scrollDiff(1);
        else if (key.pageUp) model.scrollDiff(-height);
        else if (key.pageDown) model.scrollDiff(height);
        break;
      case "report":
        if (key.escape) model.back();
        else if (key.upArrow) model.scrollReport(-1);
        else if (key.downArrow) model.scrollReport(1);
        else if (key.pageUp) model.scrollReport(-height);
        else if (key.pageDown) model.scrollReport(height);
        break;
      case "discard-confirm":
        if (key.escape) model.back();
        else if (key.upArrow) model.moveConfirm(-1);
        else if (key.downArrow) model.moveConfirm(1);
        else if (key.return) {
          if (model.confirmIndex === 1) void model.discard();
          else model.back();
        }
        break;
      case "apply-error":
        if (key.escape) model.back();
        else if (key.upArrow) model.move(-1);
        else if (key.downArrow) model.move(1);
        else if (key.return) void handleErrorAction(model);
        break;
      case "applied":
      case "discarded":
      case "kept":
        if (key.return || key.escape || key.ctrl === true) onExit();
        break;
    }
  });

  const widthNow = Math.max(40, width);
  return (
    <Box flexDirection="column" width={widthNow}>
      <Text bold>Conjunction</Text>
      <Separator width={widthNow} />
      <Box marginY={1}>{renderView(model, widthNow, height)}</Box>
      <Separator width={widthNow} />
      <Text> </Text>
      <Text dimColor>{helpText(model)}</Text>
    </Box>
  );
}

function renderView(model: ResultActionsModel, width: number, height: number): React.JSX.Element {
  switch (model.view) {
    case "actions":
      return <ActionsView model={model} />;
    case "diff":
      return (
        <ScrollView
          title="Diff"
          text={model.diffText}
          offset={model.diffOffset}
          height={height}
          width={width}
        />
      );
    case "report":
      return (
        <ScrollView
          title="Report"
          text={model.reportText}
          offset={model.reportOffset}
          height={height}
          width={width}
        />
      );
    case "discard-confirm":
      return <DiscardConfirm model={model} />;
    case "apply-error":
      return <ApplyError model={model} />;
    case "applied":
      return (
        <DoneView
          title="✓ Changes applied"
          lines={model.statusLines}
          note="Temporary workspace cleaned up."
        />
      );
    case "discarded":
      return (
        <DoneView
          title="✓ Changes discarded"
          lines={model.statusLines}
          note="Your project is untouched."
        />
      );
    case "kept":
      return <DoneView title="Changes kept isolated" lines={model.statusLines} />;
  }
}

function ActionsView({ model }: { model: ResultActionsModel }): React.JSX.Element {
  const actionLabels: Record<string, string> = {
    apply: "Apply changes",
    diff: "View diff",
    report: "View report",
    keep: "Keep isolated",
    discard: "Discard changes",
  };
  return (
    <Box flexDirection="column">
      <Text bold>What next?</Text>
      <Text> </Text>
      {model.actions.map((action, index) => (
        <Text key={action}>
          <Arrow active={model.index === index} /> {actionLabels[action]}
        </Text>
      ))}
    </Box>
  );
}

function DiscardConfirm({ model }: { model: ResultActionsModel }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Discard isolated changes?
      </Text>
      <Text dimColor wrap="wrap">
        These changes have not been applied to your project.
      </Text>
      <Text> </Text>
      <Text>
        <Arrow active={model.confirmIndex === 0} /> Cancel
      </Text>
      <Text>
        <Arrow active={model.confirmIndex === 1} /> Discard &amp; clean up
      </Text>
    </Box>
  );
}

function ApplyError({ model }: { model: ResultActionsModel }): React.JSX.Element {
  const error = model.landOutcome?.error ?? "could not apply changes";
  return (
    <Box flexDirection="column">
      <Text bold color="red">
        ✗ Could not apply changes
      </Text>
      <Text dimColor wrap="wrap">
        {error}
      </Text>
      <Text dimColor wrap="wrap">
        Your isolated workspace is safe and has been preserved.
      </Text>
      <Text> </Text>
      <Text>
        <Arrow active={model.index === 0} /> Retry
      </Text>
      <Text>
        <Arrow active={model.index === 1} /> View diff
      </Text>
      <Text>
        <Arrow active={model.index === 2} /> Keep isolated
      </Text>
      <Text>
        <Arrow active={model.index === 3} /> Back
      </Text>
    </Box>
  );
}

function DoneView({
  title,
  lines,
  note,
}: {
  title: string;
  lines: string[];
  note?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text key={index} wrap="wrap">
          {line}
        </Text>
      ))}
      {note !== undefined && (
        <Text dimColor wrap="wrap">
          {note}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>Press Enter to exit</Text>
    </Box>
  );
}

function ScrollView({
  title,
  text,
  offset,
  height,
  width,
}: {
  title: string;
  text: string;
  offset: number;
  height: number;
  width: number;
}): React.JSX.Element {
  const lines = text.split("\n");
  const visible = Math.max(3, height - 6);
  const maxOffset = Math.max(0, lines.length - visible);
  const top = Math.min(offset, maxOffset);
  const window = lines.slice(top, top + visible);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text> </Text>
      <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>
      {top > 0 && <Text dimColor>↑ more</Text>}
      {window.map((line, index) => (
        <Text key={index} wrap="wrap" dimColor={line.trim().length === 0}>
          {line.length === 0 ? " " : line}
        </Text>
      ))}
      {top + visible < lines.length && <Text dimColor>↓ more</Text>}
      <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>
      <Text dimColor>↑ ↓ scroll · Esc back</Text>
    </Box>
  );
}

function helpText(model: ResultActionsModel): string {
  switch (model.view) {
    case "actions":
      return "↑↓ navigate · Enter select · Esc exit";
    case "diff":
    case "report":
      return "↑ ↓ scroll · PageUp/PageDown · Esc back";
    case "discard-confirm":
      return "↑↓ navigate · Enter select · Esc cancel";
    case "apply-error":
      return "↑↓ navigate · Enter select · Esc back";
    case "applied":
    case "discarded":
    case "kept":
      return "Press Enter to exit";
  }
}

async function selectAction(model: ResultActionsModel): Promise<void> {
  const action = model.actions[model.index];
  if (action === undefined) return;
  switch (action) {
    case "apply":
      await model.apply();
      break;
    case "diff":
      await model.viewDiff();
      break;
    case "report":
      await model.viewReport();
      break;
    case "keep":
      await model.keep();
      break;
    case "discard":
      model.openDiscard();
      break;
  }
}

async function handleErrorAction(model: ResultActionsModel): Promise<void> {
  if (model.index === 0) {
    await model.apply();
  } else if (model.index === 1) {
    await model.viewDiff();
  } else if (model.index === 2) {
    await model.keep();
  } else {
    model.back();
  }
}
