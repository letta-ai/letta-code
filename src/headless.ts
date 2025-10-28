import { parseArgs } from "node:util";
import { Letta } from "@letta-ai/letta-client";
import { getClient } from "./agent/client";
import { createAgent } from "./agent/create";
import { sendMessageStream } from "./agent/message";
import { SessionStats } from "./agent/stats";
import { createBuffers, toLines } from "./cli/helpers/accumulator";
import { safeJsonParseOr } from "./cli/helpers/safeJsonParse";
import { drainStream } from "./cli/helpers/stream";
import { loadSettings, updateSettings } from "./settings";
import { checkToolPermission, executeTool } from "./tools/manager";

export async function handleHeadlessCommand(argv: string[]) {
  const settings = await loadSettings();

  // Parse CLI args
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      continue: { type: "boolean", short: "c" },
      agent: { type: "string", short: "a" },
      "output-format": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  // Get prompt from either positional args or stdin
  let prompt = positionals.slice(2).join(" ");

  // If no prompt provided as args, try reading from stdin
  if (!prompt) {
    // Check if stdin is available (piped input)
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      prompt = Buffer.concat(chunks).toString("utf-8").trim();
    }
  }

  if (!prompt) {
    console.error("Error: No prompt provided");
    process.exit(1);
  }

  const client = getClient();

  // Resolve agent (same logic as interactive mode)
  let agent: Letta.AgentState | null = null;
  const specifiedAgentId = values.agent as string | undefined;
  const shouldContinue = values.continue as boolean | undefined;

  if (specifiedAgentId) {
    try {
      agent = await client.agents.retrieve(specifiedAgentId);
    } catch (_error) {
      console.error(`Agent ${specifiedAgentId} not found, creating new one...`);
    }
  }

  if (!agent && shouldContinue && settings.lastAgent) {
    try {
      agent = await client.agents.retrieve(settings.lastAgent);
    } catch (_error) {
      console.error(
        `Previous agent ${settings.lastAgent} not found, creating new one...`,
      );
    }
  }

  if (!agent) {
    agent = await createAgent();
    await updateSettings({ lastAgent: agent.id });
  }

  // Validate output format
  const outputFormat =
    (values["output-format"] as string | undefined) || "text";
  if (!["text", "json", "stream-json"].includes(outputFormat)) {
    console.error(
      `Error: Invalid output format "${outputFormat}". Valid formats: text, json, stream-json`,
    );
    process.exit(1);
  }

  // Create buffers to accumulate stream
  const buffers = createBuffers();

  // Initialize session stats
  const sessionStats = new SessionStats();

  // Send message and process stream loop
  let currentInput: Array<Letta.MessageCreate | Letta.ApprovalCreate> = [
    {
      role: Letta.MessageCreateRole.User,
      content: [{ type: "text", text: prompt }],
    },
  ];

  try {
    while (true) {
      const stream = await sendMessageStream(agent.id, currentInput);

      // Drain stream and collect approval requests
      const { stopReason, approval, apiDurationMs } = await drainStream(
        stream,
        buffers,
        () => {}, // No UI refresh needed in headless mode
      );

      // Track API duration for this stream
      sessionStats.endTurn(apiDurationMs);

      // Case 1: Turn ended normally
      if (stopReason === Letta.StopReasonType.EndTurn) {
        break;
      }

      // Case 2: Requires approval
      if (stopReason === Letta.StopReasonType.RequiresApproval) {
        if (!approval) {
          console.error("Unexpected null approval");
          process.exit(1);
        }

        const { toolCallId, toolName, toolArgs } = approval;

        // Check permission using existing permission system
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          toolArgs,
          {},
        );
        const permission = await checkToolPermission(toolName, parsedArgs);

        // Handle deny decision
        if (permission.decision === "deny") {
          const denyReason = `Permission denied: ${permission.matchedRule || permission.reason}`;
          currentInput = [
            {
              type: "approval",
              approvalRequestId: toolCallId,
              approve: false,
              reason: denyReason,
            },
          ];
          continue;
        }

        // Handle ask decision - in headless mode, auto-deny
        if (permission.decision === "ask") {
          currentInput = [
            {
              type: "approval",
              approvalRequestId: toolCallId,
              approve: false,
              reason: "Tool requires approval (headless mode)",
            },
          ];
          continue;
        }

        // Permission is "allow" - auto-execute tool and continue loop
        const toolResult = await executeTool(toolName, parsedArgs);

        currentInput = [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                toolCallId,
                toolReturn: toolResult.toolReturn,
                status: toolResult.status,
                stdout: toolResult.stdout,
                stderr: toolResult.stderr,
              },
            ],
          },
        ];
        continue;
      }

      // Unexpected stop reason
      // TODO: For error stop reasons (error, llm_api_error, etc.), fetch step details
      // using lastRunId to get full error message from step.errorData
      // Example: client.runs.steps.list(lastRunId, { limit: 1, order: "desc" })
      // Then display step.errorData.message or full error details instead of generic message
      console.error(`Unexpected stop reason: ${stopReason}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  // Update stats with final usage data from buffers
  sessionStats.updateUsageFromBuffers(buffers);

  // Extract final assistant message
  const lines = toLines(buffers);
  const lastAssistant = [...lines]
    .reverse()
    .find((line) => line.kind === "assistant");

  const resultText =
    lastAssistant && "text" in lastAssistant
      ? lastAssistant.text
      : "No assistant response found";

  // Output based on format
  if (outputFormat === "json") {
    const stats = sessionStats.getSnapshot();
    const output = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      session_id: agent.id,
      usage: {
        input_tokens: stats.usage.promptTokens,
        output_tokens: stats.usage.completionTokens,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (outputFormat === "stream-json") {
    console.error("stream-json format not yet implemented");
    process.exit(1);
  } else {
    // text format (default)
    if (!lastAssistant || !("text" in lastAssistant)) {
      console.error("No assistant response found");
      process.exit(1);
    }
    console.log(lastAssistant.text);
  }
}
