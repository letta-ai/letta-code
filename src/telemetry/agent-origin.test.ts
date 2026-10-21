import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveTelemetryAgentOrigin } from "@/telemetry/agent-origin";
import { type TelemetryEvent, telemetry } from "@/telemetry/index";

type TelemetryTestState = {
  events: TelemetryEvent[];
  currentAgentId: string | null;
  currentAgentOrigin: string | null;
};

const telemetryState = telemetry as unknown as TelemetryTestState;
const originalTelemetrySetting = process.env.LETTA_CODE_TELEM;

describe("telemetry agent origin", () => {
  beforeEach(() => {
    telemetryState.events = [];
    telemetryState.currentAgentId = null;
    telemetryState.currentAgentOrigin = null;
    process.env.LETTA_CODE_TELEM = "1";
  });

  afterEach(() => {
    if (originalTelemetrySetting === undefined) {
      delete process.env.LETTA_CODE_TELEM;
    } else {
      process.env.LETTA_CODE_TELEM = originalTelemetrySetting;
    }
  });

  test("maps only allowlisted agent tags to analytics values", () => {
    expect(
      resolveTelemetryAgentOrigin([
        "customer:private",
        "origin:claude-subconcious",
      ]),
    ).toBe("claude-subconscious");
    expect(
      resolveTelemetryAgentOrigin([
        "customer:private",
        "origin:unrecognized-product",
      ]),
    ).toBeUndefined();
  });

  test("enriches queued and subsequent events after headless agent resolution", () => {
    telemetry.trackSessionStart();

    telemetry.setCurrentAgent("agent-subconscious", [
      "customer:private",
      "origin:claude-subconcious",
    ]);
    telemetry.trackUserInput("hello", "user", "model-1");

    expect(telemetryState.events).toHaveLength(2);
    for (const event of telemetryState.events) {
      expect(event.data.agent_id).toBe("agent-subconscious");
      expect(event.data.agent_origin).toBe("claude-subconscious");
      expect(event.data).not.toHaveProperty("agent_tags");
      expect(JSON.stringify(event.data)).not.toContain("customer:private");
    }
  });
});
