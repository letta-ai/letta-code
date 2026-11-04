import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import {
  classifyExternalCodingAgentStartupError,
  formatExternalCodingAgentId,
  nativeSessionSourceFor,
  parseExternalCodingAgentId,
  runExternalCodingAgent,
} from "./external-coding-agent";
import {
  clearNativeSessionCaptureForTests,
  getNativeSessionOwner,
} from "./native-session-capture";
import type { PiTurnOptions } from "./pi-rpc-session";

const SESSION_ID = "0190f5c2-6c1e-7b3a-9f4e-1a2b3c4d5e6f";

beforeAll(() => settingsManager.initialize());
afterEach(() => clearNativeSessionCaptureForTests());

describe("pi external coding agent", () => {
  test("formats and parses pi worker IDs, including qualified ones", () => {
    expect(formatExternalCodingAgentId("pi", SESSION_ID)).toBe(
      `pi_${SESSION_ID}`,
    );
    expect(
      parseExternalCodingAgentId(
        formatExternalCodingAgentId("pi", SESSION_ID, "direct:box"),
      ),
    ).toEqual({ type: "pi", sessionId: SESSION_ID, computer: "direct:box" });
    expect(parseExternalCodingAgentId("pi_not-a-uuid")).toBeNull();
    expect(nativeSessionSourceFor("pi")).toBe("pi");
    expect(nativeSessionSourceFor("cursor")).toBeUndefined();
  });

  test("checks pi --version, then runs the RPC turn and records the session owner", async () => {
    const preflight: Array<[string, string[]]> = [];
    let seen: PiTurnOptions | undefined;
    const started: string[] = [];
    const result = await runExternalCodingAgent(
      {
        type: "pi",
        prompt: "Fix it",
        model: "anthropic/claude-sonnet-4-5",
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        actingUserId: null,
        onStarted: (id) => started.push(id),
      },
      {
        resolveSecretEnv: async () => ({}),
        runPreflight: async (executable, args) => {
          preflight.push([executable, args]);
          return { exitCode: 0, stdout: "1.5.0", stderr: "" };
        },
        runPiTurn: async (options) => {
          seen = options;
          await options.beforeStart?.(SESSION_ID);
          options.onStarted?.(SESSION_ID);
          return {
            agentId: `pi_${SESSION_ID}`,
            runtimeSessionId: SESSION_ID,
            report: "Fixed",
            success: true,
          };
        },
      },
    );
    expect(preflight).toEqual([["pi", ["--version"]]]);
    expect(seen).toMatchObject({
      prompt: "Fix it",
      model: "anthropic/claude-sonnet-4-5",
      parentAgentId: "agent-parent",
    });
    expect(result).toMatchObject({ success: true, report: "Fixed" });
    expect(started).toEqual([`pi_${SESSION_ID}`]);
    expect(getNativeSessionOwner("pi", SESSION_ID)).toMatchObject({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
  });

  test("a failing pi --version is classified as not installed", async () => {
    const result = await runExternalCodingAgent(
      { type: "pi", prompt: "p", parentAgentId: "agent-parent" },
      {
        resolveSecretEnv: async () => ({}),
        runPreflight: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "broken install",
        }),
        runPiTurn: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi executable is not ready: broken install");
    expect(classifyExternalCodingAgentStartupError(result.error ?? "")).toBe(
      "not_installed",
    );
  });

  test("a missing API key is classified as not signed in", () => {
    expect(
      classifyExternalCodingAgentStartupError(
        "pi is not signed in: No API key found for the selected model.",
      ),
    ).toBe("not_signed_in");
  });
});
