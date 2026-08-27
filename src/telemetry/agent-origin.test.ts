import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveTelemetryAgentOrigins } from "@/telemetry/agent-origin";
import { type TelemetryEvent, telemetry } from "@/telemetry/index";

type TelemetryTestState = {
  events: TelemetryEvent[];
  currentAgentId: string | null;
  currentAgentOrigins: string[];
};

const telemetryState = telemetry as unknown as TelemetryTestState;
const originalTelemetrySetting = process.env.LETTA_CODE_TELEM;

describe("telemetry agent origin", () => {
  beforeEach(() => {
    telemetryState.events = [];
    telemetryState.currentAgentId = null;
    telemetryState.currentAgentOrigins = [];
    process.env.LETTA_CODE_TELEM = "1";
  });

  afterEach(() => {
    if (originalTelemetrySetting === undefined) {
      delete process.env.LETTA_CODE_TELEM;
    } else {
      process.env.LETTA_CODE_TELEM = originalTelemetrySetting;
    }
  });

  test("extracts only bounded origin tags", () => {
    expect(
      resolveTelemetryAgentOrigins([
        "customer:private",
        "origin:claude-subconcious",
        "origin:letta-code",
        "origin:letta-code",
        "origin:",
        "origin:Customer Name",
      ]),
    ).toEqual(["claude-subconcious", "letta-code"]);

    expect(
      resolveTelemetryAgentOrigins(
        Array.from({ length: 10 }, (_, index) => `origin:product-${index}`),
      ),
    ).toEqual(Array.from({ length: 8 }, (_, index) => `product-${index}`));
  });

  test("enriches queued and subsequent events after headless agent resolution", () => {
    telemetry.trackSessionStart();

    telemetry.setCurrentAgent("agent-subconscious", [
      "customer:private",
      "origin:claude-subconcious",
      "origin:letta-code",
    ]);
    telemetry.trackUserInput("hello", "user", "model-1");

    expect(telemetryState.events).toHaveLength(2);
    for (const event of telemetryState.events) {
      expect(event.data.agent_id).toBe("agent-subconscious");
      expect(event.data.agent_origins).toEqual([
        "claude-subconcious",
        "letta-code",
      ]);
      expect(event.data).not.toHaveProperty("agent_tags");
      expect(JSON.stringify(event.data)).not.toContain("customer:private");
    }
  });
});
