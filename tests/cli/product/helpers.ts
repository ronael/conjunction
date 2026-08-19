import {
  StaticRuntimeRegistry,
  type AgentAdapter,
  type AgentAvailability,
  type AgentCapabilities,
  type AgentRunInput,
  type AgentRunResult,
} from "../../../src/core/index.js";

export function caps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    supportsReadOnly: true,
    supportsStructuredOutput: true,
    reasoningEffort: [],
    ...overrides,
  };
}

export function fakeAdapter(
  id: string,
  options: { caps?: AgentCapabilities; available?: boolean; reason?: string } = {},
): AgentAdapter {
  const { caps: capabilities = caps(), available = true, reason } = options;
  return {
    id,
    capabilities: () => capabilities,
    detect: async (): Promise<AgentAvailability> =>
      available
        ? { available: true, version: `${id} stub` }
        : { available: false, reason: reason ?? "not installed" },
    run: async (input: AgentRunInput): Promise<AgentRunResult> => ({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      ...(input.instructions.length > 0 ? { lastMessage: "ok" } : {}),
    }),
  };
}

export function registry(adapters: AgentAdapter[]): StaticRuntimeRegistry {
  return new StaticRuntimeRegistry(adapters);
}
