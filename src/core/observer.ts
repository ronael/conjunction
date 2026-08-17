import type { RunReport } from "./report.js";

export type ObserverSeverity = "info" | "warning" | "major";

export interface ObserverFinding {
  severity: ObserverSeverity;
  message: string;
  evidence?: string;
}

export interface ObserverReport {
  summary: string;
  findings: ObserverFinding[];
}

export const OBSERVER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "major"] },
          message: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildObserverPacket(report: RunReport): string {
  const facts = {
    task: report.task,
    outcome: report.outcome,
    metrics: report.metrics,
    invocations: report.invocations,
    verification: report.verification,
    review: report.review,
    acceptanceCoverage: report.acceptanceCoverage,
    warnings: report.warnings,
  };
  return [
    "You are the Conjunction Observer. You are read-only and advisory.",
    "Interpret only the structured facts below. Do not invent metrics from transcripts.",
    "Report concerns that are supported by explicit evidence. Do not modify files.",
    "",
    "## Structured facts",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "",
    "Return exactly one JSON object matching the provided schema.",
  ].join("\n");
}

export function parseObserverReport(raw: string): { report: ObserverReport; structured: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("observer output must be an object");
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.summary !== "string" || !Array.isArray(record.findings)) {
      throw new Error("observer output missing summary/findings");
    }
    const findings: ObserverFinding[] = record.findings.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error("observer finding must be an object");
      }
      const finding = item as Record<string, unknown>;
      if (!isSeverity(finding.severity) || typeof finding.message !== "string") {
        throw new Error("observer finding missing severity/message");
      }
      return {
        severity: finding.severity,
        message: finding.message,
        ...(typeof finding.evidence === "string" ? { evidence: finding.evidence } : {}),
      };
    });
    return { report: { summary: record.summary, findings }, structured: true };
  } catch {
    return {
      report: {
        summary: "observer returned no parseable structured output",
        findings:
          raw.trim().length === 0
            ? [{ severity: "warning", message: "observer returned no output" }]
            : [{ severity: "warning", message: raw.trim() }],
      },
      structured: false,
    };
  }
}

function isSeverity(value: unknown): value is ObserverSeverity {
  return value === "info" || value === "warning" || value === "major";
}
