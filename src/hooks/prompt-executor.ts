// src/hooks/prompt-executor.ts
// Executes prompt-based hooks by sending hook input to an LLM for evaluation

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
 * Execute a prompt-based hook by sending the hook input to an LLM
 *
 * NOTE: This is a placeholder implementation. When the direct LLM call endpoint
 * is available, this will be updated to make actual API calls.
 */
export async function executePromptHook(
  hook: PromptHookConfig,
  input: HookInput,
  _workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  const startTime = Date.now();

  try {
    // Build the user prompt with $ARGUMENTS replaced
    const userPrompt = buildPrompt(hook.prompt, input);
    const model = hook.model || DEFAULT_PROMPT_MODEL;
    const timeout = hook.timeout ?? DEFAULT_PROMPT_TIMEOUT_MS;

    // Call the LLM for hook evaluation
    const llmResponse = await callLLMForHookEvaluation(
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
 * PLACEHOLDER: Call LLM for hook evaluation
 *
 * This function is a placeholder that will be replaced with a direct LLM call
 * endpoint. Currently, it throws an error to indicate the placeholder status.
 *
 * Future implementation will look something like:
 * ```
 * const client = await getClient();
 * const response = await client.llm.complete({
 *   model,
 *   messages: [
 *     { role: "system", content: systemPrompt },
 *     { role: "user", content: userPrompt },
 *   ],
 * });
 * return response.content;
 * ```
 */
async function callLLMForHookEvaluation(
  _systemPrompt: string,
  _userPrompt: string,
  _model: string,
  _timeout: number,
): Promise<string> {
  // TODO: Implement direct LLM call when endpoint is available
  // For now, throw an error indicating this is a placeholder
  throw new Error(
    "Prompt hooks are not yet fully implemented. " +
      "Waiting for direct LLM call endpoint that doesn't require an agent ID. " +
      "This placeholder will be replaced with a direct API call.",
  );
}
