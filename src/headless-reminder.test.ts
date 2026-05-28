import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless shared reminder wiring", () => {
  test("one-shot mode builds shared reminders with system-info flag", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain('isSubagent ? "subagent" : "headless-one-shot"');
    expect(source).toContain("systemInfoReminderEnabled,");
  });

  test("all headless drains pass context tracker for compaction-driven reminder state", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("syncReminderStateFromContextTracker(");
    expect(source).toContain("reminderContextTracker");
  });

  test("headless uses the effective runtime cwd for init events and reminders", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'import { getCurrentWorkingDirectory } from "./runtime-context";',
    );
    expect(source).toContain("cwd: getCurrentWorkingDirectory()");
    expect(source).toContain("workingDirectory: getCurrentWorkingDirectory()");
    expect(source).toContain(
      "settingsManager.getLocalLastAgentId(\n      getCurrentWorkingDirectory(),",
    );
  });

  test("subagent mode is wired via LETTA_CODE_AGENT_ROLE check", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'process.env.LETTA_CODE_AGENT_ROLE === "subagent"',
    );
    expect(source).toContain('isSubagent ? "subagent" : "headless-one-shot"');
    expect(source).toContain(
      'isSubagent ? "subagent" : "headless-bidirectional"',
    );
  });

  test("one-shot approval drain uses shared stream processor", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      "const approvalStream = await sendScopedApprovalMessages(",
    );
    expect(source).toContain("await drainStreamWithResume(");
    expect(source).not.toContain("for await (const _ of approvalStream)");
  });

  test("bidirectional mode wires reflection launcher into shared reminders", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("const maybeLaunchReflectionSubagent = async (");
    expect(source).toContain("buildAutoReflectionPayload(");
    expect(source).toContain('subagentType: "reflection"');
    expect(source).toContain("maybeLaunchReflectionSubagent,");
  });

  test("bidirectional mode records successful turns for reflection", () => {
    const headlessPath = fileURLToPath(
      new URL("./headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("const userOtid = randomUUID();");
    expect(source).toContain("buffers.userLineIdByOtid.set(userOtid");
    expect(source).toContain("content: enrichedContent, otid: userOtid");
    expect(source).toContain("appendTranscriptDeltaJsonl(");
  });
});
