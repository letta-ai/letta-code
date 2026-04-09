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
    expect(telemetrySource).toContain("trackReflectionStart(");
    expect(telemetrySource).toContain("trackReflectionEnd(");
    expect(telemetrySource).toContain("start_message_id");
    expect(telemetrySource).toContain("end_message_id");
  });

  test("interactive app tracks reflection start/end for manual and auto launches", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");

    expect(appSource).toContain('telemetry.trackReflectionStart("manual"');
    expect(appSource).toContain('telemetry.trackReflectionEnd("manual"');
    expect(appSource).toContain("telemetry.trackReflectionStart(triggerSource");
    expect(appSource).toContain("telemetry.trackReflectionEnd(triggerSource");
    expect(appSource).toContain("startMessageId: autoPayload.startMessageId");
    expect(appSource).toContain("endMessageId: autoPayload.endMessageId");
  });

  test("listener turn loop tracks reflection start/end for auto launches", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const turnSource = readFileSync(turnPath, "utf-8");

    expect(turnSource).toContain(
      "telemetry.trackReflectionStart(triggerSource",
    );
    expect(turnSource).toContain("telemetry.trackReflectionEnd(triggerSource");
    expect(turnSource).toContain("startMessageId: autoPayload.startMessageId");
    expect(turnSource).toContain("endMessageId: autoPayload.endMessageId");
  });
});
