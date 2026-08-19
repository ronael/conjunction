import { Box, Text, useInput } from "ink";
import React, { useSyncExternalStore } from "react";

import type { ComposerModel, ComposerRole } from "./composer-model.js";
import { TextField } from "./components.js";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

const ROLE_LABEL: Record<ComposerRole, string> = {
  driver: "Driver",
  worker: "Worker",
  review: "Review",
};

function targetLabel(target: { runtime: string; model?: string }): string {
  if (target.runtime.length === 0) return "(none)";
  if (target.model === undefined) return target.runtime;
  const slash = target.model.lastIndexOf("/");
  const short = slash >= 0 ? target.model.slice(slash + 1) : target.model;
  return `${target.runtime} · ${short}`;
}

function Arrow({ active }: { active: boolean }): React.JSX.Element {
  return active ? <Text color="cyan">›</Text> : <Text> </Text>;
}

function Help({ text }: { text: string }): React.JSX.Element {
  return (
    <Text dimColor wrap="wrap">
      {text}
    </Text>
  );
}

function Separator({ width }: { width: number }): React.JSX.Element {
  return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
}

export function ComposerApp({
  composer,
  width,
  height,
  onExit,
  tick,
}: {
  composer: ComposerModel;
  width: number;
  height: number;
  onExit: () => void;
  tick: number;
}): React.JSX.Element {
  useSyncExternalStore(composer.subscribe, composer.getVersion);

  const textMode =
    composer.screen === "task" ||
    (composer.screen === "verification" && composer.verificationMode === "custom") ||
    composer.customModelOpen;

  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "◐";

  useInput(
    (input, key) => {
      handleNav(composer, input, key, onExit);
    },
    { isActive: !textMode },
  );

  return (
    <Box flexDirection="column" width={width}>
      <Text bold>Conjunction</Text>
      <Separator width={width} />
      <Box marginY={1}>
        {composer.screen === "task" && <TaskScreen composer={composer} />}
        {composer.screen === "workflow" && <WorkflowScreen composer={composer} />}
        {composer.screen === "agents" &&
          (composer.agentPicker !== undefined ? (
            <AgentPickerScreen composer={composer} height={height} spinner={spinner} />
          ) : (
            <AgentsScreen composer={composer} />
          ))}
        {composer.screen === "verification" && <VerificationScreen composer={composer} />}
        {composer.screen === "summary" && <SummaryScreen composer={composer} />}
      </Box>
      <Separator width={width} />
      <Text> </Text>
      {textMode ? (
        <TextField
          value={fieldValue(composer)}
          cursor={fieldCursor(composer)}
          onChange={fieldChange(composer)}
          onContinue={fieldContinue(composer)}
          onEscape={() => fieldEscape(composer, onExit)}
          placeholder={fieldPlaceholder(composer)}
          active
        />
      ) : (
        <Footer composer={composer} />
      )}
    </Box>
  );
}

function TaskScreen({ composer }: { composer: ComposerModel }): React.JSX.Element {
  const value = composer.taskText.trim();
  return (
    <Box flexDirection="column">
      <Text bold>What should Conjunction do?</Text>
      {value.length === 0 && (
        <Text dimColor>Enter a task, or paste a brief. Press Enter to continue.</Text>
      )}
    </Box>
  );
}

function WorkflowScreen({ composer }: { composer: ComposerModel }): React.JSX.Element {
  const selected = composer.workflowIndex;
  return (
    <Box flexDirection="column">
      <Text bold>Workflow</Text>
      <Text> </Text>
      {composer.workflowChoices.map((choice, index) => (
        <Box key={choice.id} flexDirection="column">
          <Text>
            <Arrow active={index === selected} /> {choice.label}
          </Text>
          {index === selected && <Text dimColor> {choice.blurb}</Text>}
        </Box>
      ))}
    </Box>
  );
}

function AgentsScreen({ composer }: { composer: ComposerModel }): React.JSX.Element {
  const rows: { role: ComposerRole }[] = [
    { role: "driver" },
    { role: "worker" },
    { role: "review" },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Agents</Text>
      <Text> </Text>
      {rows.map(({ role }) => (
        <Text key={role}>
          {ROLE_LABEL[role].padEnd(8)}
          <Text dimColor>
            {targetLabel(composer.agents[role].target)}
            {role === "review"
              ? `  [${composer.agents.review.enabled ? "Enabled" : "Disabled"}]`
              : ""}
          </Text>
        </Text>
      ))}
      <Text> </Text>
      {rows.map(({ role }, index) => (
        <Text key={role}>
          <Arrow active={composer.agentIndex === index} /> {ROLE_LABEL[role]}
          {role === "review" && (
            <Text dimColor> (space: {composer.agents.review.enabled ? "disable" : "enable"})</Text>
          )}
        </Text>
      ))}
      <Text>
        <Arrow active={composer.agentIndex === 3} /> Continue
      </Text>
    </Box>
  );
}

function AgentPickerScreen({
  composer,
  height,
  spinner,
}: {
  composer: ComposerModel;
  height: number;
  spinner: string;
}): React.JSX.Element {
  const role = composer.agentPicker?.role;
  if (role === undefined) return <Text />;
  const title = `Choose ${composer.agentPicker?.stage === "runtime" ? "runtime" : "model"} for ${ROLE_LABEL[role]}`;
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text> </Text>
      {composer.agentPicker?.stage === "runtime" ? (
        <RuntimeList composer={composer} role={role} />
      ) : composer.modelLoading ? (
        <Text>
          {spinner} Discovering {composer.agents[role].target.runtime} models…
        </Text>
      ) : composer.modelError !== undefined ? (
        <ModelError composer={composer} />
      ) : composer.customModelOpen ? (
        <Text dimColor>Enter model id (e.g. provider/model):</Text>
      ) : (
        <ModelList composer={composer} height={height} />
      )}
    </Box>
  );
}

function RuntimeList({
  composer,
  role,
}: {
  composer: ComposerModel;
  role: ComposerRole;
}): React.JSX.Element {
  const options = composer.runtimeOptionsFor(role);
  return (
    <Box flexDirection="column">
      {options.map((option, index) => (
        <Text key={option.entry.id} dimColor={!option.selectable} wrap="wrap">
          <Arrow active={composer.runtimeIndex === index} /> {option.entry.id}
          {option.reason !== undefined && <Text dimColor> — {option.reason}</Text>}
        </Text>
      ))}
    </Box>
  );
}

function ModelList({
  composer,
  height,
}: {
  composer: ComposerModel;
  height: number;
}): React.JSX.Element {
  const total = composer.modelOptionCount();
  const visibleCount = Math.max(3, Math.min(total, height - 8));
  const start = Math.max(
    0,
    Math.min(composer.modelIndex - Math.floor(visibleCount / 2), total - visibleCount),
  );
  const end = start + visibleCount;
  const items = composer.modelList.slice(start, end);
  const hasRuntimeDefault = composer.modelList.length === 0;
  const rows: { label: string; note?: string; index: number }[] = [];
  if (hasRuntimeDefault) {
    rows.push({ label: "Runtime default", index: 0 });
  }
  for (const [i, model] of items.entries()) {
    rows.push(
      model.free === true
        ? { label: model.label, note: "Free", index: start + i }
        : { label: model.label, index: start + i },
    );
  }
  rows.push({ label: "Custom model…", index: composer.modelList.length });
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>↑ more</Text>}
      {rows.map((row) => (
        <Text key={row.label} wrap="wrap">
          <Arrow active={composer.modelIndex === row.index} /> {row.label}
          {row.note !== undefined && <Text dimColor> [{row.note}]</Text>}
        </Text>
      ))}
      {end < total && <Text dimColor>↓ more</Text>}
    </Box>
  );
}

function ModelError({ composer }: { composer: ComposerModel }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color="red" wrap="wrap">
        Could not list{" "}
        {composer.agentPicker?.role
          ? composer.agents[composer.agentPicker.role].target.runtime
          : ""}{" "}
        models.
      </Text>
      <Text dimColor wrap="wrap">
        {composer.modelError}
      </Text>
      <Text> </Text>
      <Text>› Retry</Text>
      <Text> Enter model manually</Text>
      <Text> Back</Text>
    </Box>
  );
}

function VerificationScreen({ composer }: { composer: ComposerModel }): React.JSX.Element {
  const modes: { id: "auto" | "custom" | "none"; label: string }[] = [
    { id: "auto", label: "Auto-detect" },
    { id: "custom", label: "Custom command" },
    { id: "none", label: "None" },
  ];
  const activeIndex = composer.verificationIndex;
  return (
    <Box flexDirection="column">
      <Text bold>Verification</Text>
      <Text> </Text>
      {modes.map((mode, index) => (
        <Text key={mode.id}>
          <Arrow active={activeIndex === index} /> {mode.label}
        </Text>
      ))}
      {composer.verificationMode === "auto" && composer.verificationCandidates.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>Detected:</Text>
          {composer.verificationCandidates.map((candidate, index) => (
            <Text key={candidate.name}>
              <Arrow active={composer.candidateIndex === index} /> {candidate.name}
            </Text>
          ))}
        </>
      )}
      {composer.verificationMode === "auto" && composer.verificationCandidates.length === 0 && (
        <Text dimColor> no scripts detected — use Custom or None</Text>
      )}
      {composer.verificationMode === "custom" && (
        <Text dimColor> Enter a command, e.g. pnpm test:</Text>
      )}
    </Box>
  );
}

function SummaryScreen({ composer }: { composer: ComposerModel }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Ready to run</Text>
      <Text> </Text>
      <Row k="Task" v={composer.taskTitle} />
      <Row k="Workflow" v={composer.workflowLabel} />
      <Row k="Driver" v={targetLabel(composer.agents.driver.target)} />
      <Row k="Worker" v={targetLabel(composer.agents.worker.target)} />
      {composer.workflowIndex === 0 && (
        <Row
          k="Review"
          v={
            composer.agents.review.enabled ? targetLabel(composer.agents.review.target) : "disabled"
          }
        />
      )}
      <Row k="Verify" v={composer.verifySummary} />
      <Text> </Text>
      <Text>
        <Arrow active={composer.summaryIndex === 0} /> Run
      </Text>
      <Text>
        <Arrow active={composer.summaryIndex === 1} /> Back
      </Text>
      <Text>
        <Arrow active={composer.summaryIndex === 2} /> Cancel
      </Text>
    </Box>
  );
}

function Row({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <Text wrap="wrap">
      <Text dimColor>{k.padEnd(10)}</Text>
      {v}
    </Text>
  );
}

function Footer({ composer }: { composer: ComposerModel }): React.JSX.Element {
  const text = (() => {
    switch (composer.screen) {
      case "task":
        return "Enter continue · Esc cancel";
      case "workflow":
        return "↑↓ navigate · Enter select · Esc back";
      case "agents":
        if (composer.agentPicker !== undefined) {
          return composer.agentPicker.stage === "model"
            ? "↑↓ navigate · Enter select · Esc back"
            : "↑↓ navigate · Enter select · Esc back";
        }
        return "↑↓ navigate · Enter select · Space toggle · Esc back";
      case "verification":
        return composer.verificationMode === "custom"
          ? "type a command · Enter continue · Esc back"
          : "↑↓ navigate · Enter select · Esc back";
      case "summary":
        return "↑↓ navigate · Enter select · Esc back";
      default:
        return "";
    }
  })();
  return <Help text={text} />;
}

// ── key routing ─────────────────────────────────────────────────────────────

function handleNav(
  composer: ComposerModel,
  input: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    ctrl?: boolean;
    space?: boolean;
  },
  onExit: () => void,
): void {
  if (key.ctrl && input === "c") {
    onExit();
    return;
  }
  if (key.escape) {
    composer.back();
    return;
  }
  if (composer.screen === "workflow") {
    if (key.upArrow) composer.setWorkflow(Math.max(0, composer.workflowIndex - 1));
    else if (key.downArrow) composer.setWorkflow(Math.min(1, composer.workflowIndex + 1));
    else if (key.return) composer.advance();
    return;
  }
  if (composer.screen === "agents" && composer.agentPicker !== undefined) {
    handlePickerNav(composer, key);
    return;
  }
  if (composer.screen === "agents") {
    if (key.upArrow) composer.moveAgents(-1);
    else if (key.downArrow) composer.moveAgents(1);
    else if (key.return) selectAgentRow(composer);
    else if (key.space && composer.agentIndex === 2) composer.toggleReview();
    return;
  }
  if (composer.screen === "verification") {
    handleVerificationNav(composer, key);
    return;
  }
  if (composer.screen === "summary") {
    if (key.upArrow) composer.moveSummary(-1);
    else if (key.downArrow) composer.moveSummary(1);
    else if (key.return) {
      if (composer.summaryIndex === 0) {
        composer.requestRun();
      } else if (composer.summaryIndex === 1) {
        composer.back();
      } else {
        onExit();
      }
    }
    return;
  }
}

function handlePickerNav(
  composer: ComposerModel,
  key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean },
): void {
  const picker = composer.agentPicker;
  if (picker === undefined) return;
  if (key.upArrow) {
    if (picker.stage === "runtime") composer.moveRuntime(-1);
    else composer.moveModel(-1);
  } else if (key.downArrow) {
    if (picker.stage === "runtime") composer.moveRuntime(1);
    else composer.moveModel(1);
  } else if (key.return) {
    if (picker.stage === "runtime") {
      void composer.pickRuntime();
    } else {
      composer.pickModel();
    }
  }
}

function selectAgentRow(composer: ComposerModel): void {
  const index = composer.agentIndex;
  if (index === 0) composer.openAgentPicker("driver");
  else if (index === 1) composer.openAgentPicker("worker");
  else if (index === 2) composer.openAgentPicker("review");
  else composer.advance(); // Continue
}

function handleVerificationNav(
  composer: ComposerModel,
  key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; space?: boolean },
): void {
  if (key.upArrow) {
    composer.moveVerification(-1);
  } else if (key.downArrow) {
    composer.moveVerification(1);
  } else if (key.return) {
    // Select the highlighted mode; custom stays to type a command.
    const typing = composer.selectVerificationMode();
    if (!typing) {
      composer.advance();
    }
  }
}

// ── text field wiring ───────────────────────────────────────────────────────

function fieldValue(composer: ComposerModel): string {
  if (composer.screen === "task") return composer.taskText;
  if (composer.customModelOpen) return composer.customModelText;
  return composer.customCommand;
}

function fieldCursor(composer: ComposerModel): number {
  if (composer.screen === "task") return composer.cursor;
  if (composer.customModelOpen) return composer.customModelText.length;
  return composer.customCursor;
}

function fieldChange(composer: ComposerModel): (value: string, cursor: number) => void {
  return (value, cursor) => {
    if (composer.screen === "task") composer.setTask(value, cursor);
    else if (composer.customModelOpen) composer.setCustomModelText(value);
    else composer.setCustomCommand(value, cursor);
  };
}

function fieldContinue(composer: ComposerModel): () => void {
  return () => {
    if (composer.screen === "task") composer.advance();
    else if (composer.customModelOpen) composer.applyCustomModel(composer.customModelText);
    else composer.advance();
  };
}

function fieldEscape(composer: ComposerModel, onExit: () => void): void {
  if (composer.screen === "task") {
    onExit();
  } else if (composer.customModelOpen) {
    composer.back();
  } else {
    composer.back();
  }
}

function fieldPlaceholder(composer: ComposerModel): string | undefined {
  if (composer.screen === "task") return "> Create a Todo API…";
  if (composer.customModelOpen) return "provider/model (e.g. opencode/mimo-v2.5-free)";
  return "pnpm test";
}
