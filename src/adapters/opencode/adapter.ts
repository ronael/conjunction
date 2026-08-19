import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
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

    let server: OpenCodeServer | undefined;
    try {
      const factory = this.#createOpencode === undefined ? createOpencode : this.#createOpencode;
      const serverOptions: ServerOptions = { timeout: input.timeoutMs };
      if (input.signal !== undefined) {
        serverOptions.signal = input.signal;
      }
      const created = await factory(serverOptions);
      server = created.server;
      const { client } = created;

      const sessionResult = await client.session.create({
        directory: input.workspacePath,
        title: "conjunction-run",
        model: { id: model.modelID, providerID: model.providerID },
        permission: permissionRules(input.readOnly === true),
      });
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

      const firstResult = await client.session.prompt(firstPrompt);
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
        const retryResult = await client.session.prompt(retryPrompt);
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

      const lastMessage = extractLastMessage(response, expectJson);
      const result: AgentRunResult = {
        exitCode: 0,
        timedOut: false,
        aborted: false,
        ...(lastMessage.length > 0 ? { lastMessage } : {}),
      };
      return result;
    } catch (error) {
      if (input.signal?.aborted === true) {
        return { exitCode: 1, timedOut: false, aborted: true };
      }
      return {
        exitCode: 1,
        timedOut: false,
        aborted: false,
        error: normalizeOpenCodeError(error),
      };
    } finally {
      server?.close();
    }
  }
}
