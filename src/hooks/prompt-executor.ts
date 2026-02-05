// src/hooks/prompt-executor.ts
// Executes prompt-based hooks by sending hook input to an LLM for evaluation

import { getClient } from "../agent/client";
import { getCurrentAgentId } from "../agent/context";
import {
  HookExitCode,
  type HookInput,
  type HookResult,
  PROMPT_ARGUMENTS_PLACEHOLDER,
  type PromptHookConfig,
  type PromptHookResponse,
} from "./types";

/** Default timeout for prompt hook execution (30 seconds) */
const DEFAULT_PROMPT_TIMEOUT_MS = 30000;

/** Default model for prompt hooks (fast model) */
const DEFAULT_PROMPT_MODEL = "anthropic/claude-3-5-haiku-20241022";

/**
 * System prompt for the LLM to evaluate hooks.
 * Instructs the model to return a JSON decision per Claude Code spec.
 */
const PROMPT_HOOK_SYSTEM = `You are a hook evaluator for a coding assistant. Your job is to evaluate whether an action should be allowed or blocked based on the provided context and criteria.

You will receive:
1. Hook input JSON containing context about the action (event type, tool info, etc.)
2. A user-defined prompt with evaluation criteria

You must respond with ONLY a valid JSON object (no markdown, no explanation) with the following fields:
- "ok": true to allow the action, false to prevent it
- "reason": Required when ok is false. Explanation for your decision.

Example responses:
- To allow: {"ok": true}
- To block: {"ok": false, "reason": "This action violates the security policy"}

Respond with JSON only. No markdown code blocks. No explanation outside the JSON.`;

/**
 * Build the prompt to send to the LLM, replacing $ARGUMENTS with hook input.
 * If $ARGUMENTS is not present in the prompt, append the input JSON.
 */
function buildPrompt(hookPrompt: string, input: HookInput): string {
  const inputJson = JSON.stringify(input, null, 2);

  // If $ARGUMENTS placeholder exists, replace all occurrences
  if (hookPrompt.includes(PROMPT_ARGUMENTS_PLACEHOLDER)) {
    return hookPrompt.replaceAll(PROMPT_ARGUMENTS_PLACEHOLDER, inputJson);
  }

  // Otherwise, append input JSON to the prompt
  return `${hookPrompt}\n\nHook input:\n${inputJson}`;
}

/**
 * Parse the LLM response as JSON, handling potential formatting issues
 */
function parsePromptResponse(response: string): PromptHookResponse {
  // Try to extract JSON from the response
  let jsonStr = response.trim();

  // Handle markdown code blocks
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1] || jsonStr;
  }

  // Try to find JSON object in the response
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed as PromptHookResponse;
  } catch {
    // If parsing fails, treat as error
    throw new Error(`Failed to parse LLM response as JSON: ${response}`);
  }
}

/**
 * Convert PromptHookResponse to HookResult
 */
function responseToHookResult(
  response: PromptHookResponse,
  durationMs: number,
): HookResult {
  // ok: true allows the action, ok: false (or missing) blocks it
  const shouldBlock = response.ok !== true;

  return {
    exitCode: shouldBlock ? HookExitCode.BLOCK : HookExitCode.ALLOW,
    stdout: JSON.stringify(response),
    stderr: shouldBlock ? response.reason || "" : "",
    timedOut: false,
    durationMs,
  };
}

/**
 * Extract agent_id from hook input, falling back to the global agent context.
 */
function getAgentId(input: HookInput): string | undefined {
  // 1. Check hook input directly (most hook event types include agent_id)
  if ("agent_id" in input && input.agent_id) {
    return input.agent_id;
  }
  // 2. Fall back to the global agent context (set during session)
  try {
    return getCurrentAgentId();
  } catch {
    // Context not available
  }
  // 3. Last resort: env var (set by shell env for subprocesses)
  return process.env.LETTA_AGENT_ID;
}

/**
 * JSON schema for structured prompt hook responses.
 * Forces the LLM to return {ok: boolean, reason?: string} via tool calling.
 */
const PROMPT_HOOK_RESPONSE_SCHEMA = {
  properties: {
    ok: {
      type: "boolean",
      description: "true to allow the action, false to block it",
    },
    reason: {
      type: "string",
      description:
        "Explanation for the decision. Required when ok is false.",
    },
  },
  required: ["ok"],
};

/** Response shape from POST /v1/agents/{agent_id}/generate */
interface GenerateResponse {
  content: string;
  model: string;
  usage: {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Execute a prompt-based hook by sending the hook input to an LLM
 * via the POST /v1/agents/{agent_id}/generate endpoint.
 */
export async function executePromptHook(
  hook: PromptHookConfig,
  input: HookInput,
  _workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  const startTime = Date.now();

  try {
    const agentId = getAgentId(input);
    if (!agentId) {
      throw new Error(
        "Prompt hooks require an agent_id. Ensure the hook event provides an agent_id " +
          "or set the LETTA_AGENT_ID environment variable.",
      );
    }

    // Build the user prompt with $ARGUMENTS replaced
    const userPrompt = buildPrompt(hook.prompt, input);
    const model = hook.model || DEFAULT_PROMPT_MODEL;
    const timeout = hook.timeout ?? DEFAULT_PROMPT_TIMEOUT_MS;

    // Call the generate endpoint
    const llmResponse = await callGenerateEndpoint(
      agentId,
      PROMPT_HOOK_SYSTEM,
      userPrompt,
      model,
      timeout,
    );

    // Parse the response
    const parsedResponse = parsePromptResponse(llmResponse);
    const durationMs = Date.now() - startTime;

    // Log hook completion
    const shouldBlock = parsedResponse.ok !== true;
    const exitLabel = shouldBlock
      ? "\x1b[31m✗ blocked\x1b[0m"
      : "\x1b[32m✓ allowed\x1b[0m";
    console.log(`\x1b[90m[prompt-hook] ${hook.prompt.slice(0, 50)}...\x1b[0m`);
    console.log(`\x1b[90m  ⏿ ${exitLabel} (${durationMs}ms)\x1b[0m`);
    if (parsedResponse.reason) {
      console.log(`\x1b[90m  ⏿ reason: ${parsedResponse.reason}\x1b[0m`);
    }

    return responseToHookResult(parsedResponse, durationMs);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const timedOut = errorMessage.includes("timed out");

    console.log(`\x1b[90m[prompt-hook] ${hook.prompt.slice(0, 50)}...\x1b[0m`);
    console.log(`\x1b[90m  ⏿ \x1b[33m⚠ error\x1b[0m (${durationMs}ms)\x1b[0m`);
    console.log(`\x1b[90m  ⏿ ${errorMessage}\x1b[0m`);

    return {
      exitCode: HookExitCode.ERROR,
      stdout: "",
      stderr: errorMessage,
      timedOut,
      durationMs,
      error: errorMessage,
    };
  }
}

/**
 * Call the POST /v1/agents/{agent_id}/generate endpoint for hook evaluation.
 * Uses the Letta SDK client's raw post() method since the SDK doesn't have
 * a typed generate() method yet.
 */
async function callGenerateEndpoint(
  agentId: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
  timeout: number,
): Promise<string> {
  const client = await getClient();

  const response = await client.post<GenerateResponse>(
    `/v1/agents/${agentId}/generate`,
    {
      body: {
        prompt: userPrompt,
        system_prompt: systemPrompt,
        override_model: model,
        response_schema: PROMPT_HOOK_RESPONSE_SCHEMA,
      },
      timeout,
    },
  );

  return response.content;
}
