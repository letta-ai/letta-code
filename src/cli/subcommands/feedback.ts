import { parseArgs } from "node:util";
import {
  getFeedbackClientType,
  submitFeedbackMetadata,
} from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";

const FEEDBACK_MESSAGE_MAX = 10_000;

export interface FeedbackSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  submitFeedback?: typeof submitFeedbackMetadata;
  getDeviceId?: () => string;
  getApiKey?: () => string | undefined;
  getClientType?: typeof getFeedbackClientType;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

function printUsage(stdout: (message: string) => void = console.log): void {
  stdout(
    `
Usage:
  letta feedback --message <text>

Options:
  --message <text>   Feedback to send to the Letta team
  -h, --help         Show this help

Notes:
  - Ask the user for permission before submitting feedback on their behalf.
`.trim(),
  );
}

export async function runFeedbackSubcommand(
  argv: string[],
  deps: FeedbackSubcommandDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        message: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    printUsage(stdout);
    return 1;
  }

  if (parsed.values.help) {
    printUsage(stdout);
    return 0;
  }

  const message =
    typeof parsed.values.message === "string"
      ? parsed.values.message.trim()
      : "";
  if (!message) {
    stderr("Feedback message required: pass --message <text>.");
    return 1;
  }
  if (message.length > FEEDBACK_MESSAGE_MAX) {
    stderr(
      `Feedback message is too long. Maximum is ${FEEDBACK_MESSAGE_MAX.toLocaleString()} characters.`,
    );
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const apiKey = (
    deps.getApiKey ??
    (() => {
      const settings = settingsManager.getSettings();
      return process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
    })
  )();
  const agentId = (
    process.env.LETTA_AGENT_ID ||
    process.env.AGENT_ID ||
    ""
  ).trim();
  const conversationId = (process.env.CONVERSATION_ID || "").trim();

  try {
    await (deps.submitFeedback ?? submitFeedbackMetadata)(
      apiKey,
      (deps.getDeviceId ?? (() => settingsManager.getOrCreateDeviceId()))(),
      {
        message,
        feature: "letta-code-agent-feedback",
        submission_source: "agent_skill",
        client_type: (deps.getClientType ?? getFeedbackClientType)(),
        version: getVersion(),
        platform: process.platform,
        agent_id: agentId || undefined,
        conversation_id: conversationId || undefined,
      },
    );
    stdout("Feedback submitted. Thanks for helping improve Letta Code.");
    return 0;
  } catch {
    stderr("Could not submit feedback right now. Please try again later.");
    return 1;
  }
}
