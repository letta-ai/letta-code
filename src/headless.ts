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

  const client = await getClient();

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

  // Output init event for stream-json format
  if (outputFormat === "stream-json") {
    const initEvent = {
      type: "init",
      agent_id: agent.id,
      model: agent.llmConfig?.model,
      tools: agent.tools?.map((t) => t.name) || [],
    };
    console.log(JSON.stringify(initEvent));
  }

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

      // For stream-json, output each chunk as it arrives
      let stopReason: Letta.StopReasonType;
      let approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      } | null = null;
      let apiDurationMs: number;

      if (outputFormat === "stream-json") {
        const startTime = performance.now();
        let lastStopReason: Letta.StopReasonType | null = null;

        for await (const chunk of stream) {
          // Output chunk as message event
          console.log(
            JSON.stringify({
              type: "message",
              ...chunk,
            }),
          );

          // Still accumulate for approval tracking
          const { onChunk } = await import("./cli/helpers/accumulator");
          onChunk(buffers, chunk);

          // Track stop reason and approval
          if (chunk.messageType === "stop_reason") {
            lastStopReason = chunk.stopReason;
          }

          // Track approval requests
          if (chunk.messageType === "approval_request_message") {
            const chunkWithToolCall = chunk as typeof chunk & {
              toolCall?: {
                toolCallId?: string;
                name?: string;
                arguments?: string;
              };
            };
            const toolCall = chunkWithToolCall.toolCall;
            if (toolCall?.toolCallId && toolCall?.name) {
              approval = {
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.name,
                toolArgs: toolCall.arguments || "{}",
              };
            }
          }
        }

        stopReason = lastStopReason || Letta.StopReasonType.Error;
        apiDurationMs = performance.now() - startTime;

        // Mark final line as finished
        const { markCurrentLineAsFinished } = await import(
          "./cli/helpers/accumulator"
        );
        markCurrentLineAsFinished(buffers);
      } else {
        // Normal mode: use drainStream
        const result = await drainStream(
          stream,
          buffers,
          () => {}, // No UI refresh needed in headless mode
        );
        stopReason = result.stopReason;
        approval = result.approval || null;
        apiDurationMs = result.apiDurationMs;
      }

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
      agent_id: agent.id,
      usage: {
        prompt_tokens: stats.usage.promptTokens,
        completion_tokens: stats.usage.completionTokens,
        total_tokens: stats.usage.totalTokens,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else if (outputFormat === "stream-json") {
    // Output final result event
    const stats = sessionStats.getSnapshot();
    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: agent.id,
      usage: {
        prompt_tokens: stats.usage.promptTokens,
        completion_tokens: stats.usage.completionTokens,
        total_tokens: stats.usage.totalTokens,
      },
    };
    console.log(JSON.stringify(resultEvent));
  } else {
    // text format (default)
    if (!lastAssistant || !("text" in lastAssistant)) {
      console.error("No assistant response found");
      process.exit(1);
    }
    console.log(lastAssistant.text);
  }
}
