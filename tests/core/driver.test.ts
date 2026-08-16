import { describe, expect, it } from "vitest";

import {
  DRIVER_DECISION_SCHEMA,
  parseDriverDecision,
  verificationFailureSignature,
  type VerificationOutcome,
} from "../../src/core/index.js";

describe("Driver decision model", () => {
  it("accepts the minimal delegate primitive for retry, switch, and effort choices", () => {
    const parsed = parseDriverDecision(
      JSON.stringify({
        action: "delegate",
        reason: "retry with a stronger target",
        targetId: "worker-b",
        objective: "finish the implementation",
        reasoningEffort: "high",
        supersedesInvocationId: "inv-worker-a",
      }),
    );

    expect(parsed).toEqual({
      ok: true,
      decision: {
        action: "delegate",
        reason: "retry with a stronger target",
        targetId: "worker-b",
        objective: "finish the implementation",
        reasoningEffort: "high",
        supersedesInvocationId: "inv-worker-a",
      },
    });
    expect(DRIVER_DECISION_SCHEMA.properties.action.enum).toEqual([
      "delegate",
      "verify",
      "accept",
      "stop",
    ]);
  });

  it("fails closed on malformed or semantically incomplete decisions", () => {
    expect(parseDriverDecision("not json")).toMatchObject({ ok: false });
    expect(parseDriverDecision(JSON.stringify({ action: "delegate", reason: "missing" }))).toEqual({
      ok: false,
      error: "delegate decision requires targetId",
    });
    expect(
      parseDriverDecision(
        JSON.stringify({
          action: "delegate",
          reason: "extra",
          targetId: "worker",
          objective: "do it",
          terminal: true,
        }),
      ),
    ).toEqual({ ok: false, error: "unknown driver decision field: terminal" });
  });

  it("summarizes verification failures with stable signatures", () => {
    const outcome: VerificationOutcome = {
      passed: false,
      results: [
        { name: "typecheck", exitCode: 1, timedOut: false },
        { name: "lint", exitCode: null, timedOut: true },
      ],
    };

    expect(verificationFailureSignature(outcome)).toBe("typecheck:1|lint:timeout");
    expect(verificationFailureSignature({ passed: true, results: [] })).toBe("passed");
    expect(verificationFailureSignature(undefined)).toBe("missing");
  });
});
