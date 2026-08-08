import type { AgentAdapter } from "../core/index.js";

/** Checks that the configured agent runtime is installed and usable. */
export async function doctorCommand(
  adapter: AgentAdapter,
  out: (chunk: string) => void,
): Promise<number> {
  const availability = await adapter.detect();
  if (availability.available) {
    out(
      `agent runtime "${adapter.id}": available (${availability.version ?? "unknown version"})\n`,
    );
    return 0;
  }
  out(
    `agent runtime "${adapter.id}": NOT available — ${availability.reason ?? "unknown reason"}\n`,
  );
  return 1;
}
