import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("reflection telemetry wiring", () => {
  test("telemetry manager exposes reflection start/end event types and trackers", () => {
    const telemetryPath = fileURLToPath(
      new URL("../../telemetry/index.ts", import.meta.url),
    );
    const telemetrySource = readFileSync(telemetryPath, "utf-8");

    expect(telemetrySource).toContain('"reflection_start"');
    expect(telemetrySource).toContain('"reflection_end"');
    expect(telemetrySource).toContain('"reflection_skip"');
    expect(telemetrySource).toContain("trackReflectionStart(");
    expect(telemetrySource).toContain("trackReflectionEnd(");
    expect(telemetrySource).toContain("trackReflectionSkip(");
    expect(telemetrySource).toContain("trackReflectionIdleSweep(");
    expect(telemetrySource).toContain("start_message_id");
    expect(telemetrySource).toContain("end_message_id");
    expect(telemetrySource).toContain("skipped_reason");
  });

  test("interactive app tracks reflection start/end for manual and auto launches", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const helperPath = fileURLToPath(
      new URL("../../cli/helpers/autoReflection.ts", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");
    const helperSource = readFileSync(helperPath, "utf-8");

    expect(appSource).toContain('telemetry.trackReflectionStart("manual"');
    expect(appSource).toContain('telemetry.trackReflectionEnd("manual"');
    expect(appSource).toContain("launchReflectionSubagent({");
    expect(helperSource).toContain(
      "telemetry.trackReflectionStart(triggerSource",
    );
    expect(helperSource).toContain(
      "telemetry.trackReflectionEnd(triggerSource",
    );
    expect(helperSource).toContain("telemetry.trackReflectionSkip(");
    expect(appSource).toContain("waitForBackgroundSubagentAgentId");
    expect(helperSource).toContain(
      "startMessageId: autoPayload.startMessageId",
    );
    expect(helperSource).toContain("endMessageId: autoPayload.endMessageId");
  });

  test("listener turn loop tracks reflection start/end for auto launches", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const helperPath = fileURLToPath(
      new URL("../../cli/helpers/autoReflection.ts", import.meta.url),
    );
    const turnSource = readFileSync(turnPath, "utf-8");
    const helperSource = readFileSync(helperPath, "utf-8");

    expect(turnSource).toContain("launchReflectionSubagent({");
    expect(helperSource).toContain(
      "telemetry.trackReflectionStart(triggerSource",
    );
    expect(helperSource).toContain(
      "telemetry.trackReflectionEnd(triggerSource",
    );
    expect(helperSource).toContain("waitForBackgroundSubagentAgentId");
    expect(helperSource).toContain(
      "startMessageId: autoPayload.startMessageId",
    );
    expect(helperSource).toContain("endMessageId: autoPayload.endMessageId");
  });
});
