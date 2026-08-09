/**
 * Shared visual vocabulary for CLI output (plain text and TUI alike).
 * Pure formatting only — no ink imports, so the plain path stays dependency-free.
 */

/** "1.2s" under 10s, "12s" under a minute, "1m 12s" beyond. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export type DisplayState =
  "completed" | "failed" | "cancelled" | "running" | "verifying" | "correcting" | "pending";

/** Daytona-style status glyph: green ✓, red ✗, ■ cancelled, • otherwise. */
export function stateSymbol(state: string): string {
  switch (state) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "■";
    default:
      return "•";
  }
}

export function stateLabel(state: string): string {
  return state.toUpperCase();
}
