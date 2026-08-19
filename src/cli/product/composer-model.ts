import type {
  ExecutionTarget,
  ReasoningEffort,
  RuntimeRegistry,
  WorkflowName,
} from "../../core/index.js";
import { inlineBrief } from "../brief.js";
import type { RunTaskOptions, WorkerTargetInput } from "../run-command.js";

import { ConfigStore, type ProductConfig, type VerificationPreference } from "./config-store.js";
import {
  buildRuntimeCatalog,
  type RuntimeDescriptor,
  type RuntimeModel,
} from "./runtime-catalog.js";
import { autoDetectVerification, type VerifyCandidate } from "./verify-detect.js";

export type ComposerRole = "driver" | "worker" | "review";
export type ComposerScreen = "task" | "workflow" | "agents" | "verification" | "summary";
export type AgentPickerStage = "runtime" | "model";
export type VerificationMode = "auto" | "custom" | "none";

export interface AgentState {
  target: ExecutionTarget;
}

export const WORKFLOW_CHOICES: { id: WorkflowName; label: string; blurb: string }[] = [
  { id: "quality", label: "Quality", blurb: "Driver → Worker → Verify → Review" },
  { id: "single", label: "Single", blurb: "Worker → Verify" },
];

/**
 * Plain-TS view model + controller for the Run Composer. React renders it via
 * useSyncExternalStore; all input/navigation logic lives here so it is fully
 * testable without Ink.
 */
export class ComposerModel {
  screen: ComposerScreen = "task";

  // task
  taskText = "";
  cursor = 0;

  // workflow
  workflowIndex = 0;

  // agents
  catalog: RuntimeDescriptor[] = [];
  agentIndex = 0;
  agents: Record<ComposerRole, { target: ExecutionTarget; enabled: boolean }> = {
    driver: { target: { runtime: "" }, enabled: true },
    worker: { target: { runtime: "" }, enabled: true },
    review: { target: { runtime: "" }, enabled: true },
  };
  agentPicker: { role: ComposerRole; stage: AgentPickerStage } | undefined;
  runtimeIndex = 0;
  modelIndex = 0;
  modelList: RuntimeModel[] = [];
  modelLoading = false;
  modelError: string | undefined;
  customModelOpen = false;
  customModelText = "";

  // verification
  verificationMode: VerificationMode = "auto";
  /** Navigation index over [auto, custom, none]. */
  verificationIndex = 0;
  verificationCandidates: VerifyCandidate[] = [];
  candidateIndex = 0;
  customCommand = "";
  customCursor = 0;

  // summary
  summaryIndex = 0;
  /** Set when the user picks Run on the summary screen. */
  runRequested = false;

  // persistence / preflight
  config: ProductConfig | undefined;
  configInvalid = false;
  repoError: string | undefined;
  repoRoot = "";

  #version = 0;
  #listeners = new Set<() => void>();
  #configStore: ConfigStore;

  constructor(
    private readonly registry: RuntimeRegistry,
    configStore: ConfigStore,
    private readonly cwd: string,
    private readonly opts: { discoverOpenCode?: () => Promise<RuntimeModel[]> } = {},
  ) {
    this.#configStore = configStore;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getVersion = (): number => this.#version;
  #emit(): void {
    this.#version++;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  async init(): Promise<void> {
    this.catalog = await buildRuntimeCatalog(this.registry, {
      ...(this.opts.discoverOpenCode !== undefined
        ? { discoverOpenCode: this.opts.discoverOpenCode }
        : {}),
    });
    this.config = await this.#configStore.load();
    await this.#applyInitialConfig();
    this.#emit();
  }

  async #applyInitialConfig(): Promise<void> {
    const config = this.config;
    if (config !== undefined) {
      const valid = this.#isConfigValid(config);
      this.configInvalid = !valid;
      if (valid) {
        this.workflowIndex = config.workflow === "single" ? 1 : 0;
        this.agents.driver = { target: config.driver, enabled: true };
        this.agents.worker = { target: config.worker, enabled: true };
        this.agents.review = {
          target: config.review.enabled ? config.review.target : config.worker,
          enabled: config.review.enabled,
        };
        this.verificationMode = config.verification.mode;
        if (config.verification.mode === "custom") {
          this.customCommand = config.verification.command;
        }
        return;
      }
      // invalid stored config → fall through to safe defaults, user re-picks
    }
    // first launch (or invalid): pick compatible runtimes; models default to a
    // FREE model when one is discoverable — never a silent paid choice.
    const driver = this.#defaultRuntimeFor("driver");
    const worker = this.#defaultRuntimeFor("worker");
    const review = this.#defaultRuntimeFor("review");
    if (driver !== undefined) this.agents.driver.target = { runtime: driver.id };
    if (worker !== undefined) this.agents.worker.target = { runtime: worker.id };
    if (review !== undefined) this.agents.review.target = { runtime: review.id };
    this.agents.review.enabled = true;
    this.workflowIndex = 0;
  }

  #isConfigValid(config: ProductConfig): boolean {
    const targets = [config.driver, config.worker, config.review.target];
    for (const target of targets) {
      const descriptor = this.catalog.find((entry) => entry.id === target.runtime);
      if (descriptor === undefined || !descriptor.available) {
        return false;
      }
    }
    return true;
  }

  #defaultRuntimeFor(role: ComposerRole): RuntimeDescriptor | undefined {
    return this.catalog.find((entry) => entry.available && this.#runtimeFits(entry, role));
  }

  #runtimeFits(entry: RuntimeDescriptor, role: ComposerRole): boolean {
    const caps = entry.capabilities;
    if (role === "driver" || role === "review") {
      return caps.supportsReadOnly && caps.supportsStructuredOutput;
    }
    return true; // worker
  }

  // ── navigation ────────────────────────────────────────────────────────────

  advance(): void {
    switch (this.screen) {
      case "task":
        if (this.taskText.trim().length === 0) return;
        this.screen = "workflow";
        break;
      case "workflow":
        this.screen = "agents";
        break;
      case "agents":
        if (this.agentPicker !== undefined) return;
        this.screen = "verification";
        this.verificationIndex =
          this.verificationMode === "custom" ? 1 : this.verificationMode === "none" ? 2 : 0;
        void this.loadVerificationCandidates();
        break;
      case "verification":
        this.screen = "summary";
        break;
      case "summary":
        // handled by run; keep summary
        break;
    }
    this.#emit();
  }

  back(): void {
    if (this.customModelOpen) {
      this.customModelOpen = false;
      this.#emit();
      return;
    }
    if (this.agentPicker !== undefined) {
      if (this.agentPicker.stage === "model") {
        this.agentPicker = { role: this.agentPicker.role, stage: "runtime" };
      } else {
        this.agentPicker = undefined;
      }
      this.#emit();
      return;
    }
    switch (this.screen) {
      case "task":
        break;
      case "workflow":
        this.screen = "task";
        break;
      case "agents":
        this.screen = "workflow";
        break;
      case "verification":
        this.screen = "agents";
        break;
      case "summary":
        this.screen = "verification";
        break;
    }
    this.#emit();
  }

  setWorkflow(index: number): void {
    this.workflowIndex = index;
    this.#emit();
  }

  moveAgents(offset: number): void {
    this.agentIndex = clamp(this.agentIndex + offset, 0, 3);
    this.#emit();
  }

  selectAgentRow(index: number): void {
    this.agentIndex = index;
    this.#emit();
  }

  // ── task input ────────────────────────────────────────────────────────────

  setTask(text: string, cursor: number): void {
    this.taskText = text;
    this.cursor = clamp(cursor, 0, text.length);
    this.#emit();
  }

  // ── agent pickers ─────────────────────────────────────────────────────────

  openAgentPicker(role: ComposerRole): void {
    const descriptor = this.catalog.find((entry) => entry.id === this.agents[role].target.runtime);
    this.runtimeIndex = Math.max(
      0,
      descriptor === undefined ? 0 : this.catalog.indexOf(descriptor),
    );
    this.modelList = [];
    this.modelError = undefined;
    this.customModelOpen = false;
    this.agentPicker = { role, stage: "runtime" };
    this.#emit();
  }

  runtimeOptionsFor(
    role: ComposerRole,
  ): { entry: RuntimeDescriptor; selectable: boolean; reason?: string }[] {
    return this.catalog.map((entry) => {
      if (!entry.available) {
        return { entry, selectable: false, reason: entry.reason ?? "not available" };
      }
      if (!this.#runtimeFits(entry, role)) {
        const missing: string[] = [];
        if (!entry.capabilities.supportsReadOnly) missing.push("read-only");
        if (!entry.capabilities.supportsStructuredOutput) missing.push("structured output");
        return { entry, selectable: false, reason: `missing ${missing.join(" + ")}` };
      }
      return { entry, selectable: true };
    });
  }

  moveRuntime(offset: number): void {
    this.runtimeIndex = clamp(this.runtimeIndex + offset, 0, this.catalog.length - 1);
    this.#emit();
  }

  async pickRuntime(): Promise<void> {
    const role = this.agentPicker?.role;
    if (role === undefined || this.catalog.length === 0) return;
    const option = this.runtimeOptionsFor(role)[this.runtimeIndex];
    if (option === undefined || !option.selectable) return;
    const entry = option.entry;
    this.agents[role].target = { runtime: entry.id };
    this.agentPicker = { role, stage: "model" };
    this.modelList = [];
    this.modelError = undefined;
    this.modelLoading = true;
    this.modelIndex = 0;
    this.#emit();
    if (entry.discoverModels !== undefined) {
      try {
        const models = await entry.discoverModels();
        this.modelList = models;
        this.modelLoading = false;
        this.#preselectFreeModel();
      } catch (error) {
        this.modelLoading = false;
        this.modelError = `${entry.id} models could not be listed: ${(error as Error).message}`;
      }
    } else {
      this.modelLoading = false;
      this.modelList = [];
    }
    this.#emit();
  }

  #preselectFreeModel(): void {
    const freeIndex = this.modelList.findIndex((model) => model.free === true);
    if (
      freeIndex >= 0 &&
      this.agents[this.agentPicker?.role ?? "worker"].target.model === undefined
    ) {
      this.modelIndex = freeIndex;
    }
  }

  moveModel(offset: number): void {
    const total = this.modelOptionCount();
    this.modelIndex = clamp(this.modelIndex + offset, 0, Math.max(0, total - 1));
    this.#emit();
  }

  /** Number of selectable options in the model picker. */
  modelOptionCount(): number {
    // models + "Custom model…" (+ "Runtime default" when no models are listed)
    return this.modelList.length + 1 + (this.modelList.length === 0 ? 1 : 0);
  }

  pickModel(): void {
    const role = this.agentPicker?.role;
    if (role === undefined) return;
    if (this.modelList.length === 0) {
      // index 0 = "Runtime default" (no model); index 1 = Custom model…
      if (this.modelIndex === 0) {
        this.agents[role].target = { runtime: this.agents[role].target.runtime };
        this.screen = "agents";
        this.agentPicker = undefined;
        this.#emit();
        return;
      }
      this.customModelOpen = true;
      this.customModelText = "";
      this.#emit();
      return;
    }
    if (this.modelIndex === this.modelList.length) {
      this.customModelOpen = true;
      this.customModelText = "";
      this.#emit();
      return;
    }
    const model = this.modelList[this.modelIndex];
    if (model !== undefined) {
      this.agents[role].target = { runtime: this.agents[role].target.runtime, model: model.id };
    }
    this.screen = "agents";
    this.agentPicker = undefined;
    this.#emit();
  }

  applyCustomModel(modelId: string): void {
    const role = this.agentPicker?.role;
    if (role === undefined || modelId.trim().length === 0) return;
    this.agents[role].target = { runtime: this.agents[role].target.runtime, model: modelId.trim() };
    this.customModelOpen = false;
    this.screen = "agents";
    this.agentPicker = undefined;
    this.#emit();
  }

  setCustomModelText(text: string): void {
    this.customModelText = text;
    this.#emit();
  }

  /** Retry a failed model discovery for the currently picked runtime. */
  async retryModelDiscovery(): Promise<void> {
    const role = this.agentPicker?.role;
    if (role === undefined) return;
    const entry = this.catalog.find(
      (candidate) => candidate.id === this.agents[role].target.runtime,
    );
    if (entry?.discoverModels === undefined) return;
    this.modelLoading = true;
    this.modelError = undefined;
    this.#emit();
    try {
      this.modelList = await entry.discoverModels();
      this.modelLoading = false;
      this.#preselectFreeModel();
    } catch (error) {
      this.modelLoading = false;
      this.modelError = `${entry.id} models could not be listed: ${(error as Error).message}`;
    }
    this.#emit();
  }

  toggleReview(): void {
    this.agents.review.enabled = !this.agents.review.enabled;
    this.#emit();
  }

  // ── verification ──────────────────────────────────────────────────────────

  setVerificationMode(mode: VerificationMode): void {
    this.verificationMode = mode;
    this.verificationIndex = mode === "custom" ? 1 : mode === "none" ? 2 : 0;
    this.#emit();
  }

  moveVerification(offset: number): void {
    this.verificationIndex = clamp(this.verificationIndex + offset, 0, 2);
    this.#emit();
  }

  /** Confirm the highlighted verification mode; returns true if we stay to type. */
  selectVerificationMode(): boolean {
    const mode: VerificationMode =
      this.verificationIndex === 0 ? "auto" : this.verificationIndex === 1 ? "custom" : "none";
    this.verificationMode = mode;
    this.#emit();
    return mode === "custom";
  }

  setCustomCommand(text: string, cursor: number): void {
    this.customCommand = text;
    this.customCursor = clamp(cursor, 0, text.length);
    this.#emit();
  }

  async loadVerificationCandidates(): Promise<void> {
    this.verificationCandidates = await autoDetectVerification(this.cwd);
    this.candidateIndex = 0;
    this.#emit();
  }

  setCandidateIndex(index: number): void {
    this.candidateIndex = index;
    this.#emit();
  }

  // ── summary ───────────────────────────────────────────────────────────────

  moveSummary(offset: number): void {
    this.summaryIndex = clamp(this.summaryIndex + offset, 0, 2);
    this.#emit();
  }

  // ── build ─────────────────────────────────────────────────────────────────

  buildRunOptions(): RunTaskOptions {
    const verification = this.#verificationCommands();
    return {
      brief: inlineBrief(this.taskText),
      workflow: WORKFLOW_CHOICES[this.workflowIndex]?.id ?? "quality",
      workerTarget: this.agents.worker.target,
      workerTargets: [{ id: "worker", target: this.agents.worker.target }] as WorkerTargetInput[],
      driverTarget: this.agents.driver.target,
      ...(this.agents.review.enabled && this.workflowIndex === 0
        ? { criticTarget: this.agents.review.target }
        : {}),
      repoPath: this.cwd,
      verifyCommands: verification,
      timeoutMinutes: 10,
      cleanup: false,
      correct: verification.length > 0,
      ...(this.config?.reasoningEffort !== undefined
        ? { workerReasoningEffort: this.config.reasoningEffort as ReasoningEffort }
        : {}),
    };
  }

  #verificationCommands(): RunTaskOptions["verifyCommands"] {
    if (this.verificationMode === "none") {
      return [];
    }
    if (this.verificationMode === "custom") {
      const trimmed = this.customCommand.trim();
      if (trimmed.length === 0) return [];
      const [command, ...args] = trimmed.split(/\s+/);
      return command === undefined ? [] : [{ name: trimmed, command, args }];
    }
    const candidate = this.verificationCandidates[this.candidateIndex];
    if (candidate === undefined) {
      return [];
    }
    return [{ name: candidate.name, command: candidate.command, args: candidate.args }];
  }

  /** The config the next launch should reuse (persisted on Run). */
  toConfig(): ProductConfig {
    return {
      version: 1,
      workflow: WORKFLOW_CHOICES[this.workflowIndex]?.id ?? "quality",
      driver: this.agents.driver.target,
      worker: this.agents.worker.target,
      review: {
        enabled: this.agents.review.enabled,
        target: this.agents.review.target,
      },
      verification: this.#verificationPreference(),
      ...(this.config?.reasoningEffort !== undefined
        ? { reasoningEffort: this.config.reasoningEffort }
        : {}),
    };
  }

  #verificationPreference(): VerificationPreference {
    if (this.verificationMode === "none") return { mode: "none" };
    if (this.verificationMode === "custom") return { mode: "custom", command: this.customCommand };
    return { mode: "auto" };
  }

  /** Readable labels for the summary screen. */
  get workflowLabel(): string {
    return WORKFLOW_CHOICES[this.workflowIndex]?.label ?? "Quality";
  }

  get workflowChoices(): typeof WORKFLOW_CHOICES {
    return WORKFLOW_CHOICES;
  }

  get verifySummary(): string {
    const commands = this.#verificationCommands();
    if (commands.length === 0) return "none";
    return commands.map((command) => command.name).join(", ");
  }
  get taskTitle(): string {
    const collapsed = this.taskText.replace(/\s+/g, " ").trim();
    return collapsed.length > 0 ? collapsed : "(no task)";
  }

  /** User chose Run on the summary screen. */
  requestRun(): void {
    this.runRequested = true;
    this.#emit();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
