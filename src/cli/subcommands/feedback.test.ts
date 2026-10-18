import { describe, expect, mock, test } from "bun:test";
import {
  type FeedbackSubcommandDependencies,
  runFeedbackSubcommand,
} from "@/cli/subcommands/feedback";

function createDeps(): {
  stdout: string[];
  stderr: string[];
  submissions: Array<{
    apiKey: string | undefined;
    deviceId: string;
    payload: Record<string, unknown>;
  }>;
  deps: FeedbackSubcommandDependencies;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const submissions: Array<{
    apiKey: string | undefined;
    deviceId: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    stdout,
    stderr,
    submissions,
    deps: {
      initializeSettings: mock(() => Promise.resolve()),
      getDeviceId: () => "device-1",
      getApiKey: () => "api-key-1",
      getClientType: () => "cli",
      submitFeedback: async (apiKey, deviceId, payload) => {
        submissions.push({ apiKey, deviceId, payload });
      },
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

describe("feedback subcommand", () => {
  test("prints help", async () => {
    const { stdout, deps } = createDeps();

    expect(await runFeedbackSubcommand(["--help"], deps)).toBe(0);
    expect(stdout.join("\n")).toContain("letta feedback --message <text>");
    expect(stdout.join("\n")).toContain("Ask the user for permission");
  });

  test("requires a non-empty message", async () => {
    const { stderr, deps } = createDeps();

    expect(await runFeedbackSubcommand([], deps)).toBe(1);
    expect(stderr).toEqual([
      "Feedback message required: pass --message <text> or --message-file <path>.",
    ]);
  });

  test("reads a multi-line message from --message-file intact", async () => {
    const { submissions, deps } = createDeps();
    const body =
      "Agent-submitted feedback on behalf of the user.\n\nSecond paragraph.\nThird line.\n";
    const reads: string[] = [];
    deps.readMessageFile = async (path) => {
      reads.push(path);
      return body;
    };

    expect(
      await runFeedbackSubcommand(
        ["--message-file", "C:\\Temp\\feedback.md"],
        deps,
      ),
    ).toBe(0);
    expect(reads).toEqual(["C:\\Temp\\feedback.md"]);
    expect(submissions[0]?.payload.message).toBe(body.trim());
  });

  test("rejects --message together with --message-file", async () => {
    const { stderr, submissions, deps } = createDeps();

    expect(
      await runFeedbackSubcommand(
        ["--message", "a", "--message-file", "b.md"],
        deps,
      ),
    ).toBe(1);
    expect(stderr.join("\n")).toContain("not both");
    expect(submissions).toHaveLength(0);
  });

  test("reports an unreadable --message-file without submitting", async () => {
    const { stderr, submissions, deps } = createDeps();
    deps.readMessageFile = async () => {
      throw new Error("ENOENT");
    };

    expect(
      await runFeedbackSubcommand(["--message-file", "missing.md"], deps),
    ).toBe(1);
    expect(stderr.join("\n")).toBe("Could not read feedback file: missing.md");
    expect(submissions).toHaveLength(0);
  });

  test("submits only the message and current route identifiers", async () => {
    const { stdout, submissions, deps } = createDeps();
    const oldLettaAgentId = process.env.LETTA_AGENT_ID;
    const oldAgentId = process.env.AGENT_ID;
    const oldConversationId = process.env.CONVERSATION_ID;
    delete process.env.LETTA_AGENT_ID;
    process.env.AGENT_ID = "agent-1";
    process.env.CONVERSATION_ID = "conv-1";

    try {
      expect(
        await runFeedbackSubcommand(
          ["--message", "The agent ignored my instruction."],
          deps,
        ),
      ).toBe(0);
    } finally {
      if (oldLettaAgentId === undefined) delete process.env.LETTA_AGENT_ID;
      else process.env.LETTA_AGENT_ID = oldLettaAgentId;
      if (oldAgentId === undefined) delete process.env.AGENT_ID;
      else process.env.AGENT_ID = oldAgentId;
      if (oldConversationId === undefined) delete process.env.CONVERSATION_ID;
      else process.env.CONVERSATION_ID = oldConversationId;
    }

    expect(stdout.join("\n")).toContain("Feedback submitted");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.apiKey).toBe("api-key-1");
    expect(submissions[0]?.deviceId).toBe("device-1");
    expect(submissions[0]?.payload).toMatchObject({
      message: "The agent ignored my instruction.",
      feature: "letta-code-agent-feedback",
      submission_source: "agent_skill",
      client_type: "cli",
      platform: process.platform,
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });
    expect(Object.keys(submissions[0]?.payload ?? {}).sort()).toEqual([
      "agent_id",
      "client_type",
      "conversation_id",
      "feature",
      "message",
      "platform",
      "submission_source",
      "version",
    ]);
  });

  test("returns a safe failure message", async () => {
    const { stderr, deps } = createDeps();
    deps.submitFeedback = async () => {
      throw new Error("secret backend detail");
    };

    expect(
      await runFeedbackSubcommand(["--message", "Please fix this."], deps),
    ).toBe(1);
    expect(stderr.join("\n")).toBe(
      "Could not submit feedback right now. Please try again later.",
    );
  });

  test("rejects messages longer than the feedback endpoint limit", async () => {
    const { stderr, submissions, deps } = createDeps();

    expect(
      await runFeedbackSubcommand(["--message", "x".repeat(10_001)], deps),
    ).toBe(1);
    expect(stderr.join("\n")).toContain("Maximum is 10,000 characters");
    expect(submissions).toHaveLength(0);
  });
});
