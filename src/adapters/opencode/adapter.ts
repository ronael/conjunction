import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentActivity,
  AgentAdapter,
  AgentAvailability,
  AgentCapabilities,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeError,
  ReasoningEffort,
} from "../../core/index.js";
import type { OpencodeClient, ServerOptions } from "@opencode-ai/sdk/v2";
import { createOpencode } from "@opencode-ai/sdk/v2";

const execFileAsync = promisify(execFile);

/** Options for {@link OpenCodeAdapter}. */
export interface OpenCodeAdapterOptions {
  /** OpenCode CLI binary. Default: "opencode" (resolved via PATH). */
  opencodeBin?: string;
  /** Version probe seam, injected by tests. Default: `<bin> --version`. */
  probeVersion?: (bin: string) => Promise<string>;
  /**
   * Seam for tests: replace the real `createOpencode` import.
   * The factory must return an object with `client` and `server`.
   */
  createOpencode?: CreateOpencodeFn;
}

/** Shape of the factory returned by `@opencode-ai/sdk/v2`. */
type CreateOpencodeFn = (options?: ServerOptions) => Promise<{
  client: OpencodeClient;
  server: { url: string; close(): void };
}>;

const DETECT_TIMEOUT_MS = 10_000;

/** Parse a Conjunction model string like `opencode/deepseek-v4-flash-free`. */
function parseModel(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  const [providerID, modelID] = model.split("/");
  if (providerID === undefined || providerID === "" || modelID === undefined || modelID === "") {
    return undefined;
  }
  return { providerID, modelID };
}

function runtimeUnavailable(message: string): AgentRunResult {
  return {
    exitCode: 1,
    timedOut: false,
    aborted: false,
    error: { category: "runtime_unavailable", message },
  };
}

function isCancellation(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("abort") || lower.includes("cancelled") || lower.includes("aborted");
}

function normalizeOpenCodeError(error: unknown): AgentRuntimeError {
  const message = (error as Error)?.message ?? String(error);
  const text = message.toLowerCase();
  if (isCancellation(text)) {
    return { category: "cancelled", message };
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return { category: "timeout", message };
  }
  if (text.includes("rate limit") || text.includes("429")) {
    return { category: "rate_limited", message };
  }
  if (text.includes("auth") || text.includes("401") || text.includes("403")) {
    return { category: "authentication_failed", message };
  }
  if (text.includes("overloaded") || text.includes("529")) {
    return { category: "provider_overloaded", message };
  }
  return { category: "process_failed", message };
}

function permissionRules(readOnly: boolean): PermissionRule[] {
  const base: PermissionRule[] = [
    { permission: "read", pattern: "**", action: "allow" },
    { permission: "task", pattern: "**", action: "deny" },
    { permission: "external_directory", pattern: "**", action: "deny" },
  ];
  if (readOnly) {
    return [
      ...base,
      { permission: "edit", pattern: "**", action: "deny" },
      { permission: "bash", pattern: "**", action: "deny" },
    ];
  }
  return [
    ...base,
    { permission: "edit", pattern: "**", action: "allow" },
    { permission: "bash", pattern: "**", action: "allow" },
  ];
}

/** Minimal shape of an OpenCode permission rule. */
interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

interface PromptResponse {
  info: {
    structured?: unknown;
    error?: { name: string; data?: { message?: string } };
    id?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface OpenCodeServer {
  url: string;
  close(): void;
}

function isStructuredOutputFailure(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("tool_choice") ||
    lower.includes("json_schema") ||
    lower.includes("structured output") ||
    lower.includes("json mode") ||
    lower.includes("does not support")
  );
}

function extractErrorMessage(response: PromptResponse): string | undefined {
  const infoError = response.info.error;
  if (infoError !== undefined) {
    return infoError.data?.message ?? infoError.name ?? "OpenCode request failed";
  }
  return undefined;
}

function buildTools(readOnly: boolean): Record<string, boolean> {
  return {
    edit: readOnly !== true,
    bash: readOnly !== true,
    read: true,
    glob: true,
    grep: true,
    list: true,
    task: false,
    external_directory: false,
  };
}

function buildPromptBody(input: {
  sessionID: string;
  workspacePath: string;
  model: { providerID: string; modelID: string };
  instructions: string;
  readOnly: boolean;
  outputSchema?: Record<string, unknown> | undefined;
}) {
  return {
    sessionID: input.sessionID,
    directory: input.workspacePath,
    parts: [{ type: "text" as const, text: input.instructions }],
    model: { providerID: input.model.providerID, modelID: input.model.modelID },
    tools: buildTools(input.readOnly),
    ...(input.outputSchema !== undefined
      ? {
          format: {
            type: "json_schema" as const,
            schema: input.outputSchema,
          },
        }
      : {}),
  };
}

function appendSchemaInstruction(instructions: string, schema: Record<string, unknown>): string {
  return [
    instructions,
    "",
    "## Required response format",
    "Respond with exactly one JSON object matching the following JSON Schema and no other text:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

function extractLastMessage(response: PromptResponse, expectJson: boolean): string {
  const structured = response.info.structured;
  if (structured !== undefined) {
    return JSON.stringify(structured);
  }

  const textPart = response.parts.find((p) => p.type === "text" && typeof p.text === "string");
  const rawText = textPart?.text ?? "";

  if (!expectJson) {
    return rawText;
  }

  // Some models return JSON wrapped in markdown fences even when instructed not to.
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1]?.trim() ?? rawText.trim();
  return candidate;
}

/** Validate a JSON Schema's top-level object shape without a schema dependency. */
function validateJsonAgainstSchema(
  parsed: unknown,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "expected a JSON object";
  }
  if (schema === undefined) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in record)) {
        return `missing required field: ${key}`;
      }
    }
  }
  const properties = schema.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (!(key in record)) {
        continue;
      }
      const property = value as { type?: string };
      if (typeof property.type !== "string") {
        continue;
      }
      if (property.type === "string" && typeof record[key] !== "string") {
        return `field "${key}" must be a string`;
      }
      if (property.type === "object" && (typeof record[key] !== "object" || record[key] === null)) {
        return `field "${key}" must be an object`;
      }
      if (property.type === "array" && !Array.isArray(record[key])) {
        return `field "${key}" must be an array`;
      }
      if (property.type === "number" && typeof record[key] !== "number") {
        return `field "${key}" must be a number`;
      }
      if (property.type === "boolean" && typeof record[key] !== "boolean") {
        return `field "${key}" must be a boolean`;
      }
    }
  }
  return undefined;
}

/**
 * Guarantee the "structured output" contract: when a schema was requested the
 * adapter must not hand arbitrary text back as if it were valid JSON. Returns
 * `{ lastMessage }` on success, or a normalized failure result.
 */
function normalizeStructuredOutput(
  candidate: string,
  schema: Record<string, unknown> | undefined,
): { ok: true; lastMessage: string } | { ok: false; result: AgentRunResult } {
  if (candidate.trim().length === 0) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: { category: "process_failed", message: "agent returned empty structured output" },
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: {
          category: "process_failed",
          message: `agent returned invalid JSON: ${(error as Error).message}`,
        },
      },
    };
  }
  const validationError = validateJsonAgainstSchema(parsed, schema);
  if (validationError !== undefined) {
    return {
      ok: false,
      result: {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: {
          category: "process_failed",
          message: `agent structured output invalid: ${validationError}`,
        },
      },
    };
  }
  return { ok: true, lastMessage: candidate };
}

// ── live activity: map a subset of the OpenCode event stream to AgentActivity ──

const TOOL_ACTIVITY: Record<string, AgentActivity["kind"]> = {
  read: "reading",
  grep: "searching",
  glob: "searching",
  list: "searching",
  find: "searching",
  search: "searching",
  bash: "command",
  exec: "command",
  shell: "command",
  edit: "editing",
  write: "editing",
  apply_patch: "editing",
  patch: "editing",
};

function toolActivityName(tool: string): string {
  const base = tool.replace(/^open_code_/, "");
  return TOOL_ACTIVITY[base] ?? "tool";
}

function toolLabel(tool: string): string {
  const base = tool.replace(/^open_code_/, "");
  const friendly: Record<string, string> = {
    read: "Reading",
    grep: "Searching",
    glob: "Searching",
    list: "Listing",
    find: "Searching",
    search: "Searching",
    bash: "Running command",
    exec: "Running command",
    shell: "Running command",
    edit: "Editing",
    write: "Writing",
    apply_patch: "Editing",
    patch: "Editing",
    todo: "Tracking todo",
    lsp: "Querying LSP",
    web_search: "Searching web",
    web_fetch: "Fetching URL",
  };
  return friendly[base] ?? `Using ${base}`;
}

/**
 * Subscribe to the global OpenCode event stream and translate only the events
 * that describe observable, user-meaningful work into {@link AgentActivity}.
 * Chain-of-thought, reasoning deltas and raw payloads are never forwarded.
 *
 * Returns a stop function. Best-effort: any subscription failure is swallowed
 * (activity is advisory, never affects the run outcome).
 */
function subscribeActivities(
  client: OpencodeClient,
  onActivity: (activity: AgentActivity) => void,
): () => void {
  let stopped = false;
  let iterator: AsyncIterator<never> | undefined;
  const stop = (): void => {
    stopped = true;
    iterator?.return?.(undefined).catch(() => {});
  };

  // The v2 surface exposes the native event stream; fall back to v1 when absent.
  const eventApi = (client as unknown as { v2?: { event?: { subscribe?: unknown } } }).v2?.event;
  const v1Event = (client as unknown as { event?: { subscribe?: unknown } }).event;
  const subscribeFn = eventApi?.subscribe ?? v1Event?.subscribe;

  if (typeof subscribeFn !== "function") {
    return stop;
  }
  const subscribe = subscribeFn as () => Promise<{ stream: AsyncGenerator<never> }>;

  void (async () => {
    try {
      const subscription = await subscribe();
      iterator = subscription.stream[Symbol.asyncIterator]();
      for await (const event of subscription.stream) {
        if (stopped) {
          break;
        }
        const activity = mapEventToActivity(event as { type?: string; properties?: unknown });
        if (activity !== undefined) {
          onActivity(activity);
        }
      }
    } catch {
      // activity is advisory; ignore subscription errors
    }
  })();

  return stop;
}

function mapEventToActivity(event: {
  type?: string;
  properties?: unknown;
}): AgentActivity | undefined {
  const type = event.type;
  const properties = (event.properties ?? {}) as Record<string, unknown>;
  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : "";
  switch (type) {
    case "session.next.step.started":
    case "session.next.text.started":
      return { kind: "thinking", label: "Analysing the task", detail: sessionID };
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.input.started": {
      const tool = typeof properties.tool === "string" ? properties.tool : "tool";
      const input = (properties.input ?? {}) as Record<string, unknown>;
      const file =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.path === "string"
            ? input.path
            : undefined;
      const detail = file ?? (typeof input.command === "string" ? input.command : undefined);
      const kind = toolActivityName(tool) as AgentActivity["kind"];
      return { kind, label: toolLabel(tool), ...(detail ? { detail } : {}) };
    }
    default:
      return undefined;
  }
}

/**
 * AgentAdapter for OpenCode via the official @opencode-ai/sdk.
 *
 * Each invocation starts a private OpenCode server, creates a session scoped to
 * `input.workspacePath`, sends a single prompt, and tears the server down.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";

  #bin: string;
  #probeVersion: (bin: string) => Promise<string>;
  #createOpencode: CreateOpencodeFn | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#bin = options.opencodeBin ?? "opencode";
    this.#probeVersion =
      options.probeVersion ??
      (async (bin) => {
        const { stdout } = await execFileAsync(bin, ["--version"], {
          timeout: DETECT_TIMEOUT_MS,
        });
        return stdout.trim();
      });
    this.#createOpencode = options.createOpencode;
  }

  capabilities(): AgentCapabilities {
    return {
      supportsReadOnly: true,
      supportsStructuredOutput: true,
      reasoningEffort: [] as ReasoningEffort[],
    };
  }

  async detect(): Promise<AgentAvailability> {
    try {
      const version = await this.#probeVersion(this.#bin);
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: `\`${this.#bin} --version\` failed: ${(error as Error).message}`,
      };
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const model = parseModel(input.target.model);
    if (model === undefined) {
      return runtimeUnavailable(
        `OpenCode requires a model in the form provider/model (got: ${input.target.model ?? "undefined"})`,
      );
    }

    // Real timeout enforcement: `createOpencode({ timeout })` only bounds the
    // server, not necessarily the blocking prompt. We own an AbortController
    // that fires after input.timeoutMs and also on the caller's signal, and
    // hand it to every request so a suspended prompt is actually cancelled.
    const local = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, input.timeoutMs);
    const onUserAbort = (): void => local.abort();
    if (input.signal?.aborted === true) {
      local.abort();
    } else if (input.signal !== undefined) {
      input.signal.addEventListener("abort", onUserAbort, { once: true });
    }

    let server: OpenCodeServer | undefined;
    let stopActivity: (() => void) | undefined;
    try {
      const factory = this.#createOpencode === undefined ? createOpencode : this.#createOpencode;
      const serverOptions: ServerOptions = { timeout: input.timeoutMs, signal: local.signal };
      const created = await factory(serverOptions);
      server = created.server;
      const { client } = created;

      stopActivity =
        input.onActivity !== undefined
          ? subscribeActivities(client, (activity) => input.onActivity?.(activity))
          : undefined;

      const sessionResult = await client.session.create(
        {
          directory: input.workspacePath,
          title: "conjunction-run",
          model: { id: model.modelID, providerID: model.providerID },
          permission: permissionRules(input.readOnly === true),
        },
        { signal: local.signal },
      );
      if (sessionResult.error !== undefined) {
        return {
          exitCode: 1,
          timedOut: false,
          aborted: false,
          error: normalizeOpenCodeError(sessionResult.error),
        };
      }
      const session = sessionResult.data as { id: string };
      const sessionID = session.id;

      const expectJson = input.outputSchema !== undefined;
      const outputSchema = input.outputSchema as Record<string, unknown> | undefined;

      const firstPrompt = buildPromptBody({
        sessionID,
        workspacePath: input.workspacePath,
        model,
        instructions: input.instructions,
        readOnly: input.readOnly === true,
        outputSchema,
      });

      const firstResult = await client.session.prompt(firstPrompt, { signal: local.signal });
      const firstResponse = firstResult.data as PromptResponse | undefined;
      const firstErrorMessage =
        firstResult.error !== undefined
          ? String((firstResult.error as { message?: string }).message ?? firstResult.error)
          : extractErrorMessage(firstResponse ?? { info: {}, parts: [] });

      const shouldRetryAsText =
        expectJson &&
        firstErrorMessage !== undefined &&
        isStructuredOutputFailure(firstErrorMessage);

      let response: PromptResponse;
      if (shouldRetryAsText) {
        const retryPrompt = buildPromptBody({
          sessionID,
          workspacePath: input.workspacePath,
          model,
          instructions: appendSchemaInstruction(
            input.instructions,
            outputSchema as Record<string, unknown>,
          ),
          readOnly: input.readOnly === true,
        });
        const retryResult = await client.session.prompt(retryPrompt, { signal: local.signal });
        if (retryResult.error !== undefined) {
          return {
            exitCode: 1,
            timedOut: false,
            aborted: false,
            error: normalizeOpenCodeError(retryResult.error),
          };
        }
        response = retryResult.data as PromptResponse;
      } else {
        if (firstErrorMessage !== undefined) {
          return {
            exitCode: 1,
            timedOut: false,
            aborted: false,
            error: normalizeOpenCodeError(firstErrorMessage),
          };
        }
        response = firstResponse as PromptResponse;
      }

      const rawMessage = extractLastMessage(response, expectJson);

      if (expectJson) {
        const normalized = normalizeStructuredOutput(rawMessage, outputSchema);
        if (!normalized.ok) {
          return normalized.result;
        }
        return {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          ...(normalized.lastMessage.length > 0 ? { lastMessage: normalized.lastMessage } : {}),
        };
      }

      const result: AgentRunResult = {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        ...(rawMessage.length > 0 ? { lastMessage: rawMessage } : {}),
      };
      return result;
    } catch (error) {
      if (input.signal?.aborted === true) {
        return { exitCode: 1, timedOut: false, aborted: true };
      }
      if (timedOut) {
        return {
          exitCode: 1,
          timedOut: true,
          aborted: false,
          error: { category: "timeout", message: `agent timed out after ${input.timeoutMs}ms` },
        };
      }
      return {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: normalizeOpenCodeError(error),
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (input.signal !== undefined) {
        input.signal.removeEventListener("abort", onUserAbort);
      }
      stopActivity?.();
      server?.close();
    }
  }
}
