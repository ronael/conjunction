import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecutionTarget, ReasoningEffort, WorkflowName } from "../../core/index.js";

/**
 * Minimal persisted last-run configuration, so a user does not reconfigure the
 * agents on every launch. No DB, no profiles, no secrets — just the targets.
 *
 * Stored at XDG_CONFIG_HOME/conjunction/config.json (fallback
 * ~/.config/conjunction/config.json), which is user-level and never part of a
 * tracked project. The directory is injectable for tests.
 */

export type VerificationPreference =
  { mode: "auto" } | { mode: "custom"; command: string } | { mode: "none" };

export interface ProductConfig {
  /** Versioned so a future schema change can migrate gracefully. */
  version: 1;
  workflow: WorkflowName;
  driver: ExecutionTarget;
  worker: ExecutionTarget;
  review: { enabled: boolean; target: ExecutionTarget };
  verification: VerificationPreference;
  reasoningEffort?: ReasoningEffort;
}

/** Where the user config lives on this machine (portable, injectable). */
export function userConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, "conjunction");
  }
  return path.join(homedir(), ".config", "conjunction");
}

export class ConfigStore {
  constructor(readonly dir: string) {}

  get configPath(): string {
    return path.join(this.dir, "config.json");
  }

  async load(): Promise<ProductConfig | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseConfig(raw);
    } catch {
      // A corrupt/older config is treated as absent rather than a crash.
      return undefined;
    }
  }

  async save(config: ProductConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  async clear(): Promise<void> {
    await writeFile(this.configPath, "{}", "utf8");
  }
}

function parseConfig(raw: string): ProductConfig | undefined {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }
  const workflow = record.workflow === "single" ? "single" : "quality";
  const driver = target(record.driver);
  const worker = target(record.worker);
  const reviewRaw = record.review as { enabled?: unknown; target?: unknown } | undefined;
  const reviewTarget = target(reviewRaw?.target);
  if (driver === undefined || worker === undefined) {
    return undefined;
  }
  return {
    version: 1,
    workflow,
    driver,
    worker,
    review: {
      enabled: reviewRaw?.enabled === true && reviewTarget !== undefined,
      target: reviewTarget ?? worker,
    },
    verification: parseVerification(record.verification),
    ...(typeof record.reasoningEffort === "string"
      ? { reasoningEffort: record.reasoningEffort as ReasoningEffort }
      : {}),
  };
}

function target(value: unknown): ExecutionTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.runtime !== "string" || record.runtime.length === 0) {
    return undefined;
  }
  return {
    runtime: record.runtime,
    ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
  };
}

function parseVerification(value: unknown): VerificationPreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { mode: "auto" };
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "none") {
    return { mode: "none" };
  }
  if (record.mode === "custom" && typeof record.command === "string" && record.command.length > 0) {
    return { mode: "custom", command: record.command };
  }
  return { mode: "auto" };
}
