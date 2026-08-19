import { describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "../../../src/adapters/opencode/index.js";
import type { AgentRunInput } from "../../../src/core/index.js";

const baseInput: AgentRunInput = {
  target: { runtime: "opencode", model: "opencode/deepseek-v4-flash-free" },
  reasoningEffort: "medium",
  instructions: "create hello.txt",
  workspacePath: "/tmp/conjunction-wt",
  timeoutMs: 1_000,
};

function fakeCreateOpencode(
  options: {
    onPrompt?: (params: Record<string, unknown>) => {
      info: { structured?: unknown; error?: { name: string; data?: { message?: string } } };
      parts: Array<{ type: string; text?: string }>;
    };
  } = {},
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const closed = { value: false };

  const fakeClient = {
    session: {
      create: async (params: Record<string, unknown>) => {
        calls.push({ method: "session.create", params });
        return { data: { id: "session-1" } };
      },
      prompt: async (params: Record<string, unknown>) => {
        calls.push({ method: "session.prompt", params });
        return {
          data: options.onPrompt?.(params) ?? {
            info: {},
            parts: [{ type: "text", text: "ok" }],
          },
        };
      },
    },
  };

  return {
    fn: async () => ({
      client: fakeClient as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
      server: {
        url: "http://localhost:9999",
        close: () => {
          closed.value = true;
        },
      },
    }),
    calls,
    closed,
  };
}

describe("OpenCodeAdapter", () => {
  it("has id opencode", () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.id).toBe("opencode");
  });

  it("supports read-only and structured output with no reasoning effort", () => {
    const adapter = new OpenCodeAdapter();
    expect(adapter.capabilities()).toEqual({
      supportsReadOnly: true,
      supportsStructuredOutput: true,
      reasoningEffort: [],
    });
  });

  it("detect reports availability when the binary responds", async () => {
    const adapter = new OpenCodeAdapter({
      probeVersion: async () => "opencode version 1.2.3",
    });
    const availability = await adapter.detect();
    expect(availability.available).toBe(true);
    expect(availability.version).toContain("1.2.3");
  });

  it("detect reports unavailability when the binary probe fails", async () => {
    const adapter = new OpenCodeAdapter({
      probeVersion: async () => {
        throw new Error("not found");
      },
    });
    const availability = await adapter.detect();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("not found");
  });

  it("rejects a missing model", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.run({ ...baseInput, target: { runtime: "opencode" } });
    expect(result.exitCode).toBe(1);
    expect(result.error?.category).toBe("runtime_unavailable");
    expect(result.error?.message).toContain("provider/model");
  });

  it("rejects an invalid model id", async () => {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.run({
      ...baseInput,
      target: { runtime: "opencode", model: "deepseek-v4-flash-free" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.error?.category).toBe("runtime_unavailable");
  });

  it("scopes session creation and prompt to workspacePath", async () => {
    const fake = fakeCreateOpencode();
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    await adapter.run(baseInput);

    const createCall = fake.calls.find((c) => c.method === "session.create");
    const promptCall = fake.calls.find((c) => c.method === "session.prompt");
    expect(createCall?.params.directory).toBe(baseInput.workspacePath);
    expect(createCall?.params.workspace).toBeUndefined();
    expect(promptCall?.params.directory).toBe(baseInput.workspacePath);
    expect(promptCall?.params.workspace).toBeUndefined();
  });

  it("passes parsed provider and model ids", async () => {
    const fake = fakeCreateOpencode();
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    await adapter.run(baseInput);

    const createCall = fake.calls.find((c) => c.method === "session.create");
    const promptCall = fake.calls.find((c) => c.method === "session.prompt");
    expect(createCall?.params.model).toEqual({
      id: "deepseek-v4-flash-free",
      providerID: "opencode",
    });
    expect(promptCall?.params.model).toEqual({
      providerID: "opencode",
      modelID: "deepseek-v4-flash-free",
    });
  });

  it("configures read-only permissions and disables edit/bash", async () => {
    const fake = fakeCreateOpencode();
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    await adapter.run({ ...baseInput, readOnly: true });

    const createCall = fake.calls.find((c) => c.method === "session.create");
    const permission = createCall?.params.permission as Array<{
      permission: string;
      action: string;
    }>;
    const editRule = permission.find((r) => r.permission === "edit");
    const bashRule = permission.find((r) => r.permission === "bash");
    const taskRule = permission.find((r) => r.permission === "task");
    const externalDirRule = permission.find((r) => r.permission === "external_directory");
    expect(editRule?.action).toBe("deny");
    expect(bashRule?.action).toBe("deny");
    expect(taskRule?.action).toBe("deny");
    expect(externalDirRule?.action).toBe("deny");
  });

  it("allows edit and bash for writable worker", async () => {
    const fake = fakeCreateOpencode();
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    await adapter.run(baseInput);

    const createCall = fake.calls.find((c) => c.method === "session.create");
    const permission = createCall?.params.permission as Array<{
      permission: string;
      action: string;
    }>;
    const editRule = permission.find((r) => r.permission === "edit");
    const bashRule = permission.find((r) => r.permission === "bash");
    expect(editRule?.action).toBe("allow");
    expect(bashRule?.action).toBe("allow");
  });

  it("disables task and external_directory for writable worker", async () => {
    const fake = fakeCreateOpencode();
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    await adapter.run(baseInput);

    const promptCall = fake.calls.find((c) => c.method === "session.prompt");
    const tools = promptCall?.params.tools as Record<string, boolean>;
    expect(tools.task).toBe(false);
    expect(tools.external_directory).toBe(false);
    expect(tools.edit).toBe(true);
    expect(tools.bash).toBe(true);
  });

  it("uses structured output JSON schema when outputSchema is provided", async () => {
    const fake = fakeCreateOpencode({
      onPrompt: () => ({
        info: { structured: { summary: "ok", findings: [] } },
        parts: [],
      }),
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run({
      ...baseInput,
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    });

    const promptCall = fake.calls.find((c) => c.method === "session.prompt");
    const format = promptCall?.params.format as { type: string; schema: unknown };
    expect(format.type).toBe("json_schema");
    expect(format.schema).toEqual({ type: "object", properties: { summary: { type: "string" } } });
    expect(result.lastMessage).toBe(JSON.stringify({ summary: "ok", findings: [] }));
  });

  it("returns text output when no schema is provided", async () => {
    const fake = fakeCreateOpencode({
      onPrompt: () => ({
        info: {},
        parts: [{ type: "text", text: "plain result" }],
      }),
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run(baseInput);
    expect(result.exitCode).toBe(0);
    expect(result.lastMessage).toBe("plain result");
  });

  it("closes the server even on prompt failure", async () => {
    const fake = fakeCreateOpencode();
    const badClient = {
      config: { providers: async () => ({ data: { providers: [] } }) },
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async () => {
          throw new Error("provider down");
        },
      },
    };
    const badFake = async () => ({
      client: badClient as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
      server: {
        url: "http://localhost:9999",
        close: () => {
          fake.closed.value = true;
        },
      },
    });
    const result = await new OpenCodeAdapter({ createOpencode: badFake }).run(baseInput);
    expect(result.exitCode).toBe(1);
    expect(fake.closed.value).toBe(true);
  });

  it("reports aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new OpenCodeAdapter();
    const result = await adapter.run({ ...baseInput, signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  it("falls back to text JSON extraction when structured output is rejected by the model", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    let promptCount = 0;
    const fake = fakeCreateOpencode({
      onPrompt: () => {
        promptCount++;
        if (promptCount === 1) {
          return {
            info: {
              error: {
                name: "APIError",
                data: {
                  message: "Thinking mode does not support this tool_choice",
                },
              },
            },
            parts: [],
          };
        }
        return {
          info: {},
          parts: [{ type: "text", text: '{"summary": "fallback ok"}' }],
        };
      },
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });

    expect(result.exitCode).toBe(0);
    expect(result.lastMessage).toBe('{"summary": "fallback ok"}');
    expect(promptCount).toBe(2);
    const promptCalls = fake.calls.filter((c) => c.method === "session.prompt");
    expect((promptCalls[0]?.params as { format?: { type: string } }).format?.type).toBe(
      "json_schema",
    );
    expect((promptCalls[1]?.params as { format?: { type: string } }).format).toBeUndefined();
    const parts = (promptCalls[1]!.params as { parts: Array<{ text: string }> }).parts;
    expect(parts[0]!.text).toContain("Required response format");
  });

  it("extracts JSON from markdown fences in text fallback", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    let promptCount = 0;
    const fake = fakeCreateOpencode({
      onPrompt: () => {
        promptCount++;
        if (promptCount === 1) {
          return {
            info: {
              error: {
                name: "APIError",
                data: { message: "structured output unsupported" },
              },
            },
            parts: [],
          };
        }
        return {
          info: {},
          parts: [
            {
              type: "text",
              text: 'Some explanation\n```json\n{"summary": "fenced"}\n```\n',
            },
          ],
        };
      },
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.lastMessage).toBe('{"summary": "fenced"}');
  });

  it("normalizes nested API errors returned inside the response body", async () => {
    const fake = fakeCreateOpencode({
      onPrompt: () => ({
        info: {
          error: {
            name: "APIError",
            data: { message: "529 Overloaded" },
          },
        },
        parts: [],
      }),
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run(baseInput);
    expect(result.exitCode).toBe(1);
    expect(result.error?.category).toBe("provider_overloaded");
    expect(result.error?.message).toContain("529 Overloaded");
  });

  it("invalid JSON in the text fallback yields a normalized failure, not a fake 'valid JSON'", async () => {
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    let promptCount = 0;
    const fake = fakeCreateOpencode({
      onPrompt: () => {
        promptCount++;
        if (promptCount === 1) {
          return {
            info: {
              error: { name: "APIError", data: { message: "structured output unsupported" } },
            },
            parts: [],
          };
        }
        return { info: {}, parts: [{ type: "text", text: "not json at all" }] };
      },
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.exitCode).toBe(1);
    expect(result.error?.category).toBe("process_failed");
    expect(result.error?.message).toContain("invalid JSON");
    expect(result.lastMessage).toBeUndefined();
  });

  it("valid JSON that violates the schema (missing required field) is a normalized failure", async () => {
    const schema = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    const fake = fakeCreateOpencode({
      onPrompt: () => ({ info: {}, parts: [{ type: "text", text: '{"findings": []}' }] }),
    });
    const adapter = new OpenCodeAdapter({ createOpencode: fake.fn });
    const result = await adapter.run({ ...baseInput, outputSchema: schema });
    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toContain("missing required field: summary");
  });

  it("enforces input.timeoutMs on a suspended prompt via a local abort and closes the server", async () => {
    const closed = { value: false };
    const fakeClient = {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        // never resolves; rejects only when the local timeout signal aborts
        prompt: (_params: unknown, options: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      },
    };
    const factory = async () => ({
      client: fakeClient as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
      server: {
        url: "http://localhost:9999",
        close: () => {
          closed.value = true;
        },
      },
    });
    const start = Date.now();
    const result = await new OpenCodeAdapter({ createOpencode: factory }).run({
      ...baseInput,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.error?.category).toBe("timeout");
    expect(result.error?.message).toContain("timed out after 50ms");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(closed.value).toBe(true);
  });

  it("maps OpenCode events to user-facing AgentActivity and stops the subscription", async () => {
    const seen: string[] = [];
    async function* events() {
      yield {
        id: "1",
        type: "session.next.step.started",
        properties: { sessionID: "s", timestamp: 1 },
      };
      yield {
        id: "2",
        type: "session.next.tool.called",
        properties: {
          sessionID: "s",
          callID: "c",
          tool: "edit",
          input: { file_path: "ui-test.txt" },
        },
      };
      yield {
        id: "3",
        type: "session.next.tool.called",
        properties: { sessionID: "s", callID: "c", tool: "bash", input: { command: "pnpm test" } },
      };
    }
    const fakeClient = {
      event: { subscribe: async () => ({ stream: events() }) },
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        // hold the prompt open briefly so the background event loop is consumed
        prompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { data: { info: {}, parts: [{ type: "text", text: "ok" }] } };
        },
      },
    };
    const factory = async () => ({
      client: fakeClient as unknown as import("@opencode-ai/sdk/v2").OpencodeClient,
      server: { url: "http://localhost:9999", close: () => {} },
    });
    const adapter = new OpenCodeAdapter({ createOpencode: factory });
    await adapter.run({
      ...baseInput,
      onActivity: (activity) =>
        seen.push(
          `${activity.kind}:${activity.label}${activity.detail ? `:${activity.detail}` : ""}`,
        ),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toContain("thinking:Analysing the task:s");
    expect(seen).toContain("editing:Editing:ui-test.txt");
    expect(seen).toContain("command:Running command:pnpm test");
  });
});
