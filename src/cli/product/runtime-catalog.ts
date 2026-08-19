import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentCapabilities, RuntimeRegistry } from "../../core/index.js";

const execFileAsync = promisify(execFile);
const DISCOVER_TIMEOUT_MS = 15_000;

/** One discoverable model id, humanized for display. */
export interface RuntimeModel {
  /** Exact value expected by ExecutionTarget.model (e.g. "opencode/deepseek-v4-flash-free"). */
  id: string;
  provider: string;
  /** The model portion after the provider prefix. */
  model: string;
  /** Human-friendly label, e.g. "DeepSeek V4 Flash". */
  label: string;
  /** True when the id clearly indicates a free tier (e.g. trailing "-free"). */
  free?: boolean;
}

/**
 * A runtime the Composer can offer. Nothing here is hardcoded in React — the
 * source of truth is the RuntimeRegistry; discovery fills in availability and
 * (where the runtime can) its model catalog.
 */
export interface RuntimeDescriptor {
  id: string;
  capabilities: AgentCapabilities;
  available: boolean;
  version?: string;
  reason?: string;
  /** Present only when the runtime can list its models (OpenCode). */
  discoverModels?: () => Promise<RuntimeModel[]>;
}

/**
 * Builds the catalog from the registry, probing each runtime for availability.
 * A runtime that fails to detect is still listed so the user can see why it is
 * unavailable, rather than it silently disappearing.
 *
 * `discoverOpenCode` is an injectable seam for tests; production uses the real
 * `opencode models` command.
 */
export async function buildRuntimeCatalog(
  registry: RuntimeRegistry,
  options: { discoverOpenCode?: () => Promise<RuntimeModel[]> } = {},
): Promise<RuntimeDescriptor[]> {
  const openCodeDiscover = options.discoverOpenCode ?? discoverOpenCodeModels;
  const descriptors: RuntimeDescriptor[] = [];
  for (const id of registry.ids()) {
    const adapter = registry.get(id);
    if (adapter === undefined) {
      continue;
    }
    const availability = await adapter.detect();
    const discover = modelDiscoverer(id, openCodeDiscover);
    descriptors.push({
      id,
      capabilities: adapter.capabilities(),
      available: availability.available,
      ...(availability.version !== undefined ? { version: availability.version } : {}),
      ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
      ...(discover !== undefined ? { discoverModels: discover } : {}),
    });
  }
  return descriptors;
}

function modelDiscoverer(
  id: string,
  openCodeDiscover: () => Promise<RuntimeModel[]>,
): (() => Promise<RuntimeModel[]>) | undefined {
  if (id === "opencode") {
    return openCodeDiscover;
  }
  // Claude/Codex have no reliable in-tree model listing; the Composer offers
  // the runtime default + custom model instead of a hardcoded fake list.
  return undefined;
}

/**
 * Lists OpenCode models via `opencode models` (one `provider/model` per line),
 * the official source for the installed version. Errors surface to the caller
 * so the Composer can offer Retry / Enter manually / Back.
 */
export async function discoverOpenCodeModels(
  bin = "opencode",
  exec?: (bin: string) => Promise<string>,
): Promise<RuntimeModel[]> {
  const stdout =
    exec === undefined
      ? (await execFileAsync(bin, ["models"], { timeout: DISCOVER_TIMEOUT_MS })).stdout
      : await exec(bin);
  const models: RuntimeModel[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const model = parseModelLine(trimmed);
    if (model !== undefined) {
      models.push(model);
    }
  }
  return models;
}

function parseModelLine(id: string): RuntimeModel | undefined {
  const firstSlash = id.indexOf("/");
  if (firstSlash <= 0 || firstSlash === id.length - 1) {
    return undefined;
  }
  const provider = id.slice(0, firstSlash);
  const model = id.slice(firstSlash + 1);
  const free = /-free$/i.test(model);
  return { id, provider, model, label: humanizeModel(model), ...(free ? { free: true } : {}) };
}

/** "deepseek-v4-flash-free" -> "DeepSeek V4 Flash"; "DeepSeek-V4-Flash" -> "DeepSeek V4 Flash". */
export function humanizeModel(model: string): string {
  const cleaned = model.replace(/-free$/i, "").replace(/-(\d{4}-\d{2}-\d{2})$/i, " $1");
  return cleaned
    .split(/[-_/ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
