import { parseArgs } from "node:util";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { ApprovalResult } from "./agent/approval-execution";
import { getClient } from "./agent/client";
import { initializeLoadedSkillsFlag, setAgentContext } from "./agent/context";
import { createAgent } from "./agent/create";
import { sendMessageStream } from "./agent/message";
import { getModelUpdateArgs } from "./agent/model";
import { SessionStats } from "./agent/stats";
import { createBuffers, toLines } from "./cli/helpers/accumulator";
import { safeJsonParseOr } from "./cli/helpers/safeJsonParse";
import { drainStreamWithResume } from "./cli/helpers/stream";
import { settingsManager } from "./settings-manager";
import { checkToolPermission } from "./tools/manager";

export async function handleHeadlessCommand(
  argv: string[],
  model?: string,
  skillsDirectory?: string,
) {
  const settings = settingsManager.getSettings();

  // Parse CLI args
  // Include all flags from index.ts to prevent them from being treated as positionals
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      // Flags used in headless mode
      continue: { type: "boolean", short: "c" },
      new: { type: "boolean" },
      agent: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
      toolset: { type: "string" },
      prompt: { type: "boolean", short: "p" },
      "output-format": { type: "string" },
      // Additional flags from index.ts that need to be filtered out
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      run: { type: "boolean" },
      tools: { type: "string" },
      allowedTools: { type: "string" },
      disallowedTools: { type: "string" },
      "permission-mode": { type: "string" },
      yolo: { type: "boolean" },
      skills: { type: "string" },
      link: { type: "boolean" },
      unlink: { type: "boolean" },
      sleeptime: { type: "boolean" },
      "init-blocks": { type: "string" },
      "base-tools": { type: "string" },
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
  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  const sleeptimeFlag = (values.sleeptime as boolean | undefined) ?? undefined;

  if (initBlocksRaw && !forceNew) {
    console.error(
      "Error: --init-blocks can only be used together with --new to control initial memory blocks.",
    );
    process.exit(1);
  }

  let initBlocks: string[] | undefined;
  if (initBlocksRaw !== undefined) {
    const trimmed = initBlocksRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      initBlocks = [];
    } else {
      initBlocks = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

  if (baseToolsRaw && !forceNew) {
    console.error(
      "Error: --base-tools can only be used together with --new to control initial base tools.",
    );
    process.exit(1);
  }

  let baseTools: string[] | undefined;
  if (baseToolsRaw !== undefined) {
    const trimmed = baseToolsRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      baseTools = [];
    } else {
      baseTools = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

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
    agent = await createAgent(
      undefined,
      model,
      undefined,
      updateArgs,
      forceNew,
      skillsDirectory,
      settings.parallelToolCalls,
      sleeptimeFlag ?? settings.enableSleeptime,
      undefined,
      initBlocks,
      baseTools,
    );
  }

  // Priority 3: Try to resume from project settings (.letta/settings.local.json)
  if (!agent) {
    await settingsManager.loadLocalProjectSettings();
    const localProjectSettings = settingsManager.getLocalProjectSettings();
    if (localProjectSettings?.lastAgent) {
      try {
        agent = await client.agents.retrieve(localProjectSettings.lastAgent);
      } catch (_error) {
        console.error(
          `Project agent ${localProjectSettings.lastAgent} not found, creating new one...`,
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
    agent = await createAgent(
      undefined,
      model,
      undefined,
      updateArgs,
      false,
      skillsDirectory,
      settings.parallelToolCalls,
      sleeptimeFlag ?? settings.enableSleeptime,
      undefined,
      undefined,
      undefined,
    );
  }

  // Save agent ID to both project and global settings
  await settingsManager.loadLocalProjectSettings();
  settingsManager.updateLocalProjectSettings({ lastAgent: agent.id });
  settingsManager.updateSettings({ lastAgent: agent.id });

  // Set agent context for tools that need it (e.g., Skill tool)
  setAgentContext(agent.id, client, skillsDirectory);
  await initializeLoadedSkillsFlag();

  // Re-discover skills and update the skills memory block
  // This ensures new skills added after agent creation are available
  try {
    const { discoverSkills, formatSkillsForMemory, SKILLS_DIR } = await import(
      "./agent/skills"
    );
    const { join } = await import("node:path");

    const resolvedSkillsDirectory =
      skillsDirectory || join(process.cwd(), SKILLS_DIR);
    const { skills, errors } = await discoverSkills(resolvedSkillsDirectory);

    if (errors.length > 0) {
      console.warn("Errors encountered during skill discovery:");
      for (const error of errors) {
        console.warn(`  ${error.path}: ${error.message}`);
      }
    }

    // Update the skills memory block with freshly discovered skills
    const formattedSkills = formatSkillsForMemory(
      skills,
      resolvedSkillsDirectory,
    );
    await client.agents.blocks.update("skills", {
      agent_id: agent.id,
      value: formattedSkills,
    });
  } catch (error) {
    console.warn(
      `Failed to update skills: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      model: agent.llm_config?.model,
      tools: agent.tools?.map((t) => t.name) || [],
    };
    console.log(JSON.stringify(initEvent));
  }

  // Helper to resolve any pending approvals before sending user input
  const resolveAllPendingApprovals = async () => {
    const { getResumeData } = await import("./agent/check-approval");
    while (true) {
      // Re-fetch agent to get latest in-context messages (source of truth for backend)
      const freshAgent = await client.agents.retrieve(agent.id);
      const resume = await getResumeData(client, freshAgent);

      // Use plural field for parallel tool calls
      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) break;

      // Phase 1: Collect decisions for all approvals
      type Decision =
        | {
            type: "approve";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
          }
        | {
            type: "deny";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
            reason: string;
          };

      const decisions: Decision[] = [];

      for (const currentApproval of pendingApprovals) {
        const { toolName, toolArgs } = currentApproval;
        const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
          toolArgs || "{}",
          {},
        );
        const permission = await checkToolPermission(toolName, parsedArgs);

        if (permission.decision === "deny" || permission.decision === "ask") {
          const denyReason =
            permission.decision === "ask"
              ? "Tool requires approval (headless mode)"
              : `Permission denied: ${permission.matchedRule || permission.reason}`;
          decisions.push({
            type: "deny",
            approval: currentApproval,
            reason: denyReason,
          });
          continue;
        }

        // Verify required args present; if missing, deny so the model retries with args
        const { getToolSchema } = await import("./tools/manager");
        const schema = getToolSchema(toolName);
        const required =
          (schema?.input_schema?.required as string[] | undefined) || [];
        const missing = required.filter(
          (key) => !(key in parsedArgs) || parsedArgs[key] == null,
        );
        if (missing.length > 0) {
          decisions.push({
            type: "deny",
            approval: currentApproval,
            reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
          });
          continue;
        }

        // Approve for execution
        decisions.push({
          type: "approve",
          approval: currentApproval,
        });
      }

      // Phase 2: Execute approved tools and format results using shared function
      const { executeApprovalBatch } = await import(
        "./agent/approval-execution"
      );

      // Emit auto_approval events for stream-json format
      if (outputFormat === "stream-json") {
        for (const decision of decisions) {
          if (decision.type === "approve") {
            console.log(
              JSON.stringify({
                type: "auto_approval",
                tool_name: decision.approval.toolName,
                tool_call_id: decision.approval.toolCallId,
              }),
            );
          }
        }
      }

      const executedResults = await executeApprovalBatch(decisions);

      // Send all results in one batch
      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: executedResults as ApprovalResult[],
      };

      // Send the approval to clear the pending state; drain the stream without output
      const approvalStream = await sendMessageStream(agent.id, [approvalInput]);
      if (outputFormat === "stream-json") {
        // Consume quickly but don't emit message frames to stdout
        for await (const _ of approvalStream) {
          // no-op
        }
      } else {
        await drainStreamWithResume(approvalStream, createBuffers(), () => {});
      }
    }
  };

  // Clear any pending approvals before starting a new turn
  await resolveAllPendingApprovals();

  // Build message content with reminders (plan mode first, then skill unload)
  const { permissionMode } = await import("./permissions/mode");
  const { hasLoadedSkills } = await import("./agent/context");
  let messageContent = "";

  // Add plan mode reminder if in plan mode (highest priority)
  if (permissionMode.getMode() === "plan") {
    const { PLAN_MODE_REMINDER } = await import("./agent/promptAssets");
    messageContent += PLAN_MODE_REMINDER;
  }

  // Add skill unload reminder if skills are loaded (using cached flag)
  if (hasLoadedSkills()) {
    const { SKILL_UNLOAD_REMINDER } = await import("./agent/promptAssets");
    messageContent += SKILL_UNLOAD_REMINDER;
  }

  // Add user prompt
  messageContent += prompt;

  // Start with the user message
  let currentInput: Array<MessageCreate | ApprovalCreate> = [
    {
      role: "user",
      content: [{ type: "text", text: messageContent }],
    },
  ];

  try {
    while (true) {
      const stream = await sendMessageStream(agent.id, currentInput);

      // For stream-json, output each chunk as it arrives
      let stopReason: StopReasonType;
      let approvals: Array<{
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      }> = [];
      let apiDurationMs: number;
      let lastRunId: string | null = null;

      if (outputFormat === "stream-json") {
        const startTime = performance.now();
        let lastStopReason: StopReasonType | null = null;

        // Track approval requests across streamed chunks
        const approvalRequests = new Map<
          string,
          { toolName: string; args: string }
        >();
        const autoApprovalEmitted = new Set<string>();
        let _lastApprovalId: string | null = null;

        // Track all run_ids seen during this turn
        const runIds = new Set<string>();

        for await (const chunk of stream) {
          // Track run_id if present
          if ("run_id" in chunk && chunk.run_id) {
            runIds.add(chunk.run_id);
          }

          // Detect mid-stream errors (errors without message_type)
          const chunkWithError = chunk as typeof chunk & {
            error?: { message?: string; detail?: string };
          };
          if (chunkWithError.error && !chunk.message_type) {
            // Emit as error event
            const errorMsg =
              chunkWithError.error.message || "An error occurred";
            const errorDetail = chunkWithError.error.detail || "";
            const fullErrorText = errorDetail
              ? `${errorMsg}: ${errorDetail}`
              : errorMsg;

            console.log(
              JSON.stringify({
                type: "error",
                message: fullErrorText,
                detail: errorDetail,
              }),
            );

            // Still accumulate for tracking
            const { onChunk: accumulatorOnChunk } = await import(
              "./cli/helpers/accumulator"
            );
            accumulatorOnChunk(buffers, chunk);
            continue;
          }

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

          // Track approval requests (stream-aware: accumulate by tool_call_id)
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
              // Many backends stream tool_call chunks where only the first frame
              // carries the tool_call_id; subsequent argument deltas omit it.
              // Fall back to the last seen id within this turn so we can
              // properly accumulate args.
              let id: string | null = toolCall?.tool_call_id ?? _lastApprovalId;
              if (!id) {
                // As an additional guard, if exactly one approval is being
                // tracked already, use that id for continued argument deltas.
                if (approvalRequests.size === 1) {
                  id = Array.from(approvalRequests.keys())[0] ?? null;
                }
              }
              if (!id) continue; // cannot safely attribute this chunk

              _lastApprovalId = id;

              // Concatenate argument deltas; do not inject placeholder JSON
              const prev = approvalRequests.get(id);
              const base = prev?.args ?? "";
              const incomingArgs =
                toolCall?.arguments != null ? base + toolCall.arguments : base;

              // Preserve previously seen name; set if provided in this chunk
              const nextName = toolCall?.name || prev?.toolName || "";
              approvalRequests.set(id, {
                toolName: nextName,
                args: incomingArgs,
              });

              // Keep an up-to-date approvals array for downstream handling
              // Update existing approval if present, otherwise add new one
              const existingIndex = approvals.findIndex(
                (a) => a.toolCallId === id,
              );
              const approvalObj = {
                toolCallId: id,
                toolName: nextName,
                toolArgs: incomingArgs,
              };
              if (existingIndex >= 0) {
                approvals[existingIndex] = approvalObj;
              } else {
                approvals.push(approvalObj);
              }

              // Check if this approval will be auto-approved. Dedup per tool_call_id
              if (!autoApprovalEmitted.has(id) && nextName) {
                const parsedArgs = safeJsonParseOr<Record<
                  string,
                  unknown
                > | null>(incomingArgs || "{}", null);
                const permission = await checkToolPermission(
                  nextName,
                  parsedArgs || {},
                );
                if (permission.decision === "allow" && parsedArgs) {
                  // Only emit auto_approval if we already have all required params
                  const { getToolSchema } = await import("./tools/manager");
                  const schema = getToolSchema(nextName);
                  const required =
                    (schema?.input_schema?.required as string[] | undefined) ||
                    [];
                  const missing = required.filter(
                    (key) =>
                      !(key in parsedArgs) ||
                      (parsedArgs as Record<string, unknown>)[key] == null,
                  );
                  if (missing.length === 0) {
                    shouldOutputChunk = false;
                    console.log(
                      JSON.stringify({
                        type: "auto_approval",
                        tool_name: nextName,
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
        // Use the last run_id we saw (if any)
        lastRunId = runIds.size > 0 ? Array.from(runIds).pop() || null : null;

        // Mark final line as finished
        const { markCurrentLineAsFinished } = await import(
          "./cli/helpers/accumulator"
        );
        markCurrentLineAsFinished(buffers);
      } else {
        // Normal mode: use drainStreamWithResume
        const result = await drainStreamWithResume(
          stream,
          buffers,
          () => {}, // No UI refresh needed in headless mode
        );
        stopReason = result.stopReason;
        approvals = result.approvals || [];
        apiDurationMs = result.apiDurationMs;
        lastRunId = result.lastRunId || null;
      }

      // Track API duration for this stream
      sessionStats.endTurn(apiDurationMs);

      // Case 1: Turn ended normally
      if (stopReason === "end_turn") {
        break;
      }

      // Case 2: Requires approval - batch process all approvals
      if (stopReason === "requires_approval") {
        if (approvals.length === 0) {
          console.error("Unexpected empty approvals array");
          process.exit(1);
        }

        // Phase 1: Collect decisions for all approvals
        type Decision =
          | {
              type: "approve";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
            }
          | {
              type: "deny";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
              reason: string;
            };

        const decisions: Decision[] = [];

        for (const currentApproval of approvals) {
          const { toolName, toolArgs } = currentApproval;

          // Check permission using existing permission system
          const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
            toolArgs,
            {},
          );
          const permission = await checkToolPermission(toolName, parsedArgs);

          // Handle deny decision
          if (permission.decision === "deny") {
            const denyReason = `Permission denied: ${permission.matchedRule || permission.reason}`;
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: denyReason,
            });
            continue;
          }

          // Handle ask decision - in headless mode, auto-deny
          if (permission.decision === "ask") {
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: "Tool requires approval (headless mode)",
            });
            continue;
          }

          // Permission is "allow" - verify we have required arguments before executing
          const { getToolSchema } = await import("./tools/manager");
          const schema = getToolSchema(toolName);
          const required =
            (schema?.input_schema?.required as string[] | undefined) || [];
          const missing = required.filter(
            (key) => !(key in parsedArgs) || parsedArgs[key] == null,
          );
          if (missing.length > 0) {
            // Auto-deny with a clear reason so the model can retry with arguments
            decisions.push({
              type: "deny",
              approval: currentApproval,
              reason: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
            });
            continue;
          }

          // Approve this tool for execution
          decisions.push({
            type: "approve",
            approval: currentApproval,
          });
        }

        // Phase 2: Execute all approved tools and format results using shared function
        const { executeApprovalBatch } = await import(
          "./agent/approval-execution"
        );
        const executedResults = await executeApprovalBatch(decisions);

        // Send all results in one batch
        currentInput = [
          {
            type: "approval",
            approvals: executedResults as ApprovalResult[],
          },
        ];
        continue;
      }

      // Unexpected stop reason (error, llm_api_error, etc.)
      // Extract error details from buffers if available
      const errorLines = toLines(buffers).filter(
        (line) => line.kind === "error",
      );
      const errorMessages = errorLines
        .map((line) => ("text" in line ? line.text : ""))
        .filter(Boolean);

      let errorMessage =
        errorMessages.length > 0
          ? errorMessages.join("; ")
          : `Unexpected stop reason: ${stopReason}`;

      // Fetch detailed error from run metadata if available
      if (lastRunId && errorMessages.length === 0) {
        try {
          const run = await client.runs.retrieve(lastRunId);
          if (run.metadata?.error) {
            const error = run.metadata.error as {
              type?: string;
              message?: string;
              detail?: string;
            };
            const errorType = error.type ? `[${error.type}] ` : "";
            const errorMsg = error.message || "An error occurred";
            const errorDetail = error.detail ? `: ${error.detail}` : "";
            errorMessage = `${errorType}${errorMsg}${errorDetail}`;
          }
        } catch (_e) {
          // If we can't fetch error details, append note to error message
          errorMessage = `${errorMessage}\n(Unable to fetch additional error details from server)`;
        }
      }

      if (outputFormat === "stream-json") {
        // Emit error event
        console.log(
          JSON.stringify({
            type: "error",
            message: errorMessage,
            stop_reason: stopReason,
          }),
        );
      } else {
        console.error(errorMessage);
      }
      process.exit(1);
    }
  } catch (error) {
    // Handle APIError from streaming (event: error)
    if (error instanceof APIError && error.error?.error) {
      const { type, message, detail } = error.error.error;
      const errorType = type ? `[${type}] ` : "";
      const errorMessage = message || "An error occurred";
      const errorDetail = detail ? `: ${detail}` : "";
      console.error(`Error: ${errorType}${errorMessage}${errorDetail}`);
    } else {
      // Fallback for non-API errors
      console.error(`Error: ${error}`);
    }
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

    // Collect all run_ids from buffers
    const allRunIds = new Set<string>();
    for (const line of toLines(buffers)) {
      // Extract run_id from any line that might have it
      // This is a fallback in case we missed any during streaming
      if ("run_id" in line && typeof line.run_id === "string") {
        allRunIds.add(line.run_id);
      }
    }

    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: agent.id,
      run_ids: Array.from(allRunIds),
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
