import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("listen reflection wiring", () => {
  test("routes reflection settings and auto-launch through the websocket turn loop", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const listenContextPath = fileURLToPath(
      new URL("../../reminders/listenContext.ts", import.meta.url),
    );
    const turnSource = readFileSync(turnPath, "utf-8");
    const listenContextSource = readFileSync(listenContextPath, "utf-8");

    expect(turnSource).toContain("function buildMaybeLaunchReflectionSubagent");
    expect(turnSource).toContain("buildAutoReflectionPayload(");
    expect(turnSource).toContain("finalizeAutoReflectionPayload(");
    expect(turnSource).toContain("handleMemorySubagentCompletion(");
    expect(turnSource).toContain("emitCanonicalMessageDelta(");
    expect(turnSource).toContain('message_type: "user_message"');
    expect(turnSource).toContain("<task-notification><summary>${escapeTaskNotificationSummary(");
    expect(turnSource).toContain('subagentType: "reflection"');
    expect(turnSource).toContain("appendTranscriptDeltaJsonl(");
    expect(turnSource).toContain("syncReminderStateFromContextTracker(");
    expect(turnSource).toContain("getReflectionSettings(");
    expect(turnSource).toContain("maybeLaunchReflectionSubagent:");
    expect(turnSource).toContain("runtime.contextTracker,");
    expect(turnSource).not.toContain("emitCompletionNotification: true");
    expect(turnSource).not.toContain("emitStatusDelta(socket, runtime, {");

    expect(listenContextSource).toContain(
      "reflectionSettings: ReflectionSettings",
    );
    expect(listenContextSource).toContain("maybeLaunchReflectionSubagent");
    expect(listenContextSource).not.toContain('trigger: "off"');
  });
});
