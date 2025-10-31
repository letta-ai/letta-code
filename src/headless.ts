import { parseArgs } from "node:util";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { getClient } from "./agent/client";
import { createAgent } from "./agent/create";
import { sendMessageStream } from "./agent/message";
import { getModelUpdateArgs } from "./agent/model";
import { SessionStats } from "./agent/stats";
import { createBuffers, toLines } from "./cli/helpers/accumulator";
import { safeJsonParseOr } from "./cli/helpers/safeJsonParse";
import { drainStream } from "./cli/helpers/stream";
import { loadSettings, updateSettings } from "./settings";
import { checkToolPermission, executeTool } from "./tools/manager";

export async function handleHeadlessCommand(argv: string[], model?: string) {
  const settings = await loadSettings();

  // Parse CLI args
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      continue: { type: "boolean", short: "c" },
      new: { type: "boolean" },
      agent: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
      prompt: { type: "boolean", short: "p" },
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
  let agent: AgentState | null = null;
  const specifiedAgentId = values.agent as string | undefined;
  const shouldContinue = values.continue as boolean | undefined;
  const forceNew = values.new as boolean | undefined;

  // Priority 1: Try to use --agent specified ID
  if (specifiedAgentId) {
    try {
      agent = await client.agents.retrieve(specifiedAgentId);
    } catch (_error) {
      console.error(`Agent ${specifiedAgentId} not found, creating new one...`);
    }
  }

  // Priority 2: Check if --new flag was passed (skip all resume logic)
  if (!agent && forceNew) {
    const updateArgs = getModelUpdateArgs(model);
    agent = await createAgent(undefined, model, undefined, updateArgs);
  }

  // Priority 3: Try to resume from project settings (.letta/settings.local.json)
  if (!agent) {
    const { loadProjectSettings } = await import("./settings");
    const projectSettings = await loadProjectSettings();
    if (projectSettings?.lastAgent) {
      try {
        agent = await client.agents.retrieve(projectSettings.lastAgent);
      } catch (_error) {
        console.error(
          `Project agent ${projectSettings.lastAgent} not found, creating new one...`,
        );
      }
    }
  }

  // Priority 4: Try to reuse global lastAgent if --continue flag is passed
  if (!agent && shouldContinue && settings.lastAgent) {
    try {
      agent = await client.agents.retrieve(settings.lastAgent);
    } catch (_error) {
      console.error(
        `Previous agent ${settings.lastAgent} not found, creating new one...`,
      );
    }
  }

  // Priority 5: Create a new agent
  if (!agent) {
    const updateArgs = getModelUpdateArgs(model);
    agent = await createAgent(undefined, model, undefined, updateArgs);
  }

  // Save agent ID to both project and global settings
  const { updateProjectSettings } = await import("./settings");
  await updateProjectSettings({ lastAgent: agent.id });
  await updateSettings({ lastAgent: agent.id });

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

  // Helper to resolve any pending approvals before sending user input
  const resolveAllPendingApprovals = async () => {
    const { getResumeData } = await import("./agent/check-approval");
    while (true) {
      const resume = await getResumeData(client, agent.id);
      if (!resume.pendingApproval) break;
      const { toolCallId, toolName, toolArgs } = resume.pendingApproval;
      const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
        toolArgs || "{}",
        {},
      );
      const permission = await checkToolPermission(toolName, parsedArgs);
      let approvalInput: ApprovalCreate;
      if (permission.decision === "deny" || permission.decision === "ask") {
        const denyReason =
          permission.decision === "ask"
            ? "Tool requires approval (headless mode)"
            : `Permission denied: ${permission.matchedRule || permission.reason}`;
        approvalInput = {
          type: "approval",
          approval_request_id: toolCallId,
          approve: false,
          reason: denyReason,
        };
      } else {
        // Verify required args present; if missing, deny so the model retries with args
        const { getToolSchema } = await import("./tools/manager");
        const schema = getToolSchema(toolName);
        const required =
          (schema?.input_schema?.required as string[] | undefined) || [];
        const missing = required.filter(
          (key) =>
            !(key in parsedArgs) || String(parsedArgs[key] ?? "").length === 0,
        );
        if (missing.length > 0) {
          approvalInput = {
            type: "approval",
            approval_request_id: toolCallId,
            approve: false,
            reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
          };
        } else {
          const toolResult = await executeTool(toolName, parsedArgs);
          // Emit auto_approval event for stream-json for visibility
          if (outputFormat === "stream-json") {
            console.log(
              JSON.stringify({
                type: "auto_approval",
                tool_name: toolName,
                tool_call_id: toolCallId,
                reason: permission.reason,
                matched_rule: permission.matchedRule,
              }),
            );
          }
          approvalInput = {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: toolCallId,
                tool_return: toolResult.toolReturn,
                status: toolResult.status,
                stdout: toolResult.stdout,
                stderr: toolResult.stderr,
              },
            ],
          };
        }
      }
      // Send the approval to clear the pending state; drain the stream without output
      const approvalStream = await sendMessageStream(agent.id, [approvalInput]);
      if (outputFormat === "stream-json") {
        // Consume quickly but don't emit message frames to stdout
        for await (const _ of approvalStream) {
          // no-op
        }
      } else {
        await drainStream(approvalStream, createBuffers(), () => {});
      }
    }
  };

  // Clear any pending approvals before starting a new turn
  await resolveAllPendingApprovals();

  // Start with the user message
  let currentInput: Array<MessageCreate | ApprovalCreate> = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];

  try {
    while (true) {
      const stream = await sendMessageStream(agent.id, currentInput);

      // For stream-json, output each chunk as it arrives
      let stopReason: StopReasonType;
      let approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      } | null = null;
      let apiDurationMs: number;

      if (outputFormat === "stream-json") {
        const startTime = performance.now();
        let lastStopReason: StopReasonType | null = null;

        // Track approval requests across streamed chunks
        const approvalRequests = new Map<
          string,
          { toolName: string; args: string }
        >();
        const autoApprovalEmitted = new Set<string>();
        let lastApprovalId: string | null = null;

        for await (const chunk of stream) {
          // Detect server conflict due to pending approval; handle it and retry
          const errObj = (chunk as unknown as { error?: { detail?: string } })
            .error;
          if (errObj?.detail?.includes("Cannot send a new message")) {
            // Don't emit this error; clear approvals and retry outer loop
            await resolveAllPendingApprovals();
            // Reset state and restart turn
            lastStopReason = "error" as StopReasonType;
            break;
          }
          if (
            errObj?.detail?.includes(
              "No tool call is currently awaiting approval",
            )
          ) {
            // Server isn't ready for an approval yet; let the stream continue until it is
            // Suppress the error frame from output
            continue;
          }
          // Check if we should skip outputting approval requests in bypass mode
          const isApprovalRequest =
            chunk.message_type === "approval_request_message";
          let shouldOutputChunk = true;

          // Track approval requests
          if (isApprovalRequest) {
            const chunkWithTools = chunk as typeof chunk & {
              tool_call?: {
                tool_call_id?: string;
                name?: string;
                arguments?: string;
              };
              tool_calls?: Array<{
                tool_call_id?: string;
                name?: string;
                arguments?: string;
              }>;
            };

            const toolCalls = Array.isArray(chunkWithTools.tool_calls)
              ? chunkWithTools.tool_calls
              : chunkWithTools.tool_call
                ? [chunkWithTools.tool_call]
                : [];

            for (const toolCall of toolCalls) {
              if (toolCall?.tool_call_id && toolCall?.name) {
                const id = toolCall.tool_call_id;
                lastApprovalId = id;

                // Prefer the most complete args we have seen so far; concatenate deltas
                const prev = approvalRequests.get(id);
                const base = prev && prev.args !== "{}" ? prev.args : "";
                const incomingArgs =
                  toolCall.arguments && toolCall.arguments.trim().length > 0
                    ? `${base}${toolCall.arguments}`
                    : base || "{}";

                approvalRequests.set(id, {
                  toolName: toolCall.name,
                  args: incomingArgs,
                });

                // Keep an up-to-date approval object for downstream handling
                approval = {
                  toolCallId: id,
                  toolName: toolCall.name,
                  toolArgs: incomingArgs,
                };

                // Check if this approval will be auto-approved. Dedup per tool_call_id
                if (!autoApprovalEmitted.has(id)) {
                  const parsedArgs = safeJsonParseOr<Record<
                    string,
                    unknown
                  > | null>(incomingArgs || "{}", null);
                  const permission = await checkToolPermission(
                    toolCall.name,
                    parsedArgs || {},
                  );
                  if (permission.decision === "allow" && parsedArgs) {
                    // Only emit auto_approval if we already have all required params
                    const { getToolSchema } = await import("./tools/manager");
                    const schema = getToolSchema(toolCall.name);
                    const required =
                      (schema?.input_schema?.required as
                        | string[]
                        | undefined) || [];
                    const missing = required.filter(
                      (key) =>
                        !(key in parsedArgs) ||
                        String(
                          (parsedArgs as Record<string, unknown>)[key] ?? "",
                        ).length === 0,
                    );
                    if (missing.length === 0) {
                      shouldOutputChunk = false;
                      console.log(
                        JSON.stringify({
                          type: "auto_approval",
                          tool_name: toolCall.name,
                          tool_call_id: id,
                          reason: permission.reason,
                          matched_rule: permission.matchedRule,
                        }),
                      );
                      autoApprovalEmitted.add(id);
                    }
                  }
                }
              }
            }
          }

          // Output chunk as message event (unless filtered)
          if (shouldOutputChunk) {
            console.log(
              JSON.stringify({
                type: "message",
                ...chunk,
              }),
            );
          }

          // Still accumulate for approval tracking
          const { onChunk } = await import("./cli/helpers/accumulator");
          onChunk(buffers, chunk);

          // Track stop reason
          if (chunk.message_type === "stop_reason") {
            lastStopReason = chunk.stop_reason;
          }
        }

        stopReason = lastStopReason || "error";
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
      if (stopReason === "end_turn") {
        break;
      }

      // Case 2: Requires approval
      if (stopReason === "requires_approval") {
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
              approval_request_id: toolCallId,
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
              approval_request_id: toolCallId,
              approve: false,
              reason: "Tool requires approval (headless mode)",
            },
          ];
          continue;
        }

        // Permission is "allow" - verify we have required arguments before executing
        const { getToolSchema } = await import("./tools/manager");
        const schema = getToolSchema(toolName);
        const required =
          (schema?.input_schema?.required as string[] | undefined) || [];
        const missing = required.filter(
          (key) =>
            !(key in parsedArgs) || String(parsedArgs[key] ?? "").length === 0,
        );
        if (missing.length > 0) {
          // Auto-deny with a clear reason so the model can retry with arguments
          currentInput = [
            {
              type: "approval",
              approval_request_id: toolCallId,
              approve: false,
              reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
            },
          ];
          continue;
        }

        // Execute tool and continue loop
        const toolResult = await executeTool(toolName, parsedArgs);

        currentInput = [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: toolCallId,
                tool_return: toolResult.toolReturn,
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
