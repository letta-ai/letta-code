> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Track cost and usage

> Learn how to track token usage, estimate costs, and configure prompt caching with the Claude Agent SDK.

The Claude Agent SDK provides detailed token usage information for each interaction with Claude. This guide explains how to properly track usage and understand cost reporting, especially when dealing with parallel tool uses and multi-step conversations.

For complete API documentation, see the [TypeScript SDK reference](/docs/en/agent-sdk/typescript) and [Python SDK reference](/docs/en/agent-sdk/python).

<Warning>
  The `total_cost_usd` and `costUSD` fields are client-side estimates, not authoritative billing data. The SDK computes them locally from a price table bundled at build time, so they can drift from what you are actually billed when:

  * pricing changes
  * the installed SDK version does not recognize a model
  * billing rules apply that the client cannot model

  Use these fields for development insight and approximate budgeting. For authoritative billing, use the [Usage and Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) or the Usage page in the [Claude Console](https://platform.claude.com/usage). Do not bill end users or trigger financial decisions from these fields.
</Warning>

## Understand token usage

The TypeScript and Python SDKs expose the same usage data with different field names:

* **TypeScript** provides per-step token breakdowns on each assistant message (`message.message.id`, `message.message.usage`), per-model cost via `modelUsage` on the result message, and a cumulative total on the result message.
* **Python** provides per-step token breakdowns on each assistant message as `message.usage` and `message.message_id`, per-model cost via `model_usage` on the result message, and the cumulative total on the result message as `total_cost_usd`.

Both SDKs use the same underlying cost model and expose the same granularity. The difference is in field naming and where per-step usage is nested.

Cost tracking depends on understanding how the SDK scopes usage data:

* **`query()` call:** one invocation of the SDK's `query()` function. A single call can involve multiple steps: Claude responds, uses tools, gets results, and responds again. Each call produces one [`result`](/docs/en/agent-sdk/typescript#sdkresultmessage) message at the end, except in [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), where one `query()` call carries multiple user turns and each turn emits its own `result` message.
* **Step:** a single request/response cycle within a `query()` call. Each step produces assistant messages with token usage.
* **Session:** a series of `query()` calls linked by a session ID (using the `resume` option). Each `query()` call within a session reports its own cost independently.

The following diagram shows the message stream from a single `query()` call, with token usage reported at each step and the cumulative estimate at the end:

<img src="https://mintcdn.com/claude-code/ikqp3_70mqIahteV/images/agent-sdk/message-usage-flow.svg?fit=max&auto=format&n=ikqp3_70mqIahteV&q=85&s=68497aee338e01cc745323af7aea378e" className="dark:hidden" alt="Diagram showing a query producing two steps of messages. Step 1 has four assistant messages sharing the same ID and usage (count once), Step 2 has one assistant message with a new ID, and the final result message shows the estimated total_cost_usd." width="760" height="520" data-path="images/agent-sdk/message-usage-flow.svg" />

<img src="https://mintcdn.com/claude-code/_xqph1dUOslCOwsj/images/agent-sdk/message-usage-flow-dark.svg?fit=max&auto=format&n=_xqph1dUOslCOwsj&q=85&s=8ea95085abc0a6b7f55ecef498bd4d14" className="hidden dark:block" alt="Diagram showing a query producing two steps of messages. Step 1 has four assistant messages sharing the same ID and usage (count once), Step 2 has one assistant message with a new ID, and the final result message shows the estimated total_cost_usd." width="760" height="520" data-path="images/agent-sdk/message-usage-flow-dark.svg" />

<Steps>
  <Step title="Each step produces assistant messages">
    When Claude responds, it sends one or more assistant messages. In TypeScript, each assistant message contains a nested `BetaMessage` (accessed via `message.message`) with an `id` and a [`usage`](https://platform.claude.com/docs/en/api/messages) object with token counts (`input_tokens`, `output_tokens`). In Python, the `AssistantMessage` dataclass exposes the same data directly via `message.usage` and `message.message_id`. When Claude uses multiple tools in one turn, all messages in that turn share the same ID, so deduplicate by ID to avoid double-counting.
  </Step>

  <Step title="The result message provides the cumulative estimate">
    When the `query()` call completes, the SDK emits a result message with `total_cost_usd` and cumulative `usage`, typed as [`SDKResultMessage`](/docs/en/agent-sdk/typescript#sdkresultmessage) in TypeScript and [`ResultMessage`](/docs/en/agent-sdk/python#resultmessage) in Python. If you make multiple `query()` calls, for example in a multi-turn session, each result reflects only the cost of that individual call. If you only need the estimated total, you can ignore the per-step usage and read this single value.

    In streaming input mode, each turn emits its own result message. See [Track costs in streaming input mode](#track-costs-in-streaming-input-mode) for how to read call totals in that mode.
  </Step>
</Steps>

## Track costs in streaming input mode

In [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), one `query()` call carries multiple user turns and each turn emits its own result message. The result fields differ in scope:

* **`usage`**: covers only that turn, and within it only the main agent loop, not any subagents it ran.
* **`total_cost_usd` and `modelUsage`, or `model_usage` in Python**: carry the running total for the whole call so far.

In a call where your app never sends `/clear`, `/reset`, or `/new`, read the latest result for call totals rather than summing across results.

The running totals start over each time your app sends one of those three commands, and inside a `query()` call nothing else resets them. Three results matter for your accounting:

* **The `/clear` turn's own result**: covers only what has run since the reset, and carries a new `session_id`.
* **Every later result**: keeps counting from that reset.
* **The last result before each `/clear`**: holds the total for the turns since the previous reset.

To total the whole call, add the last result from before each `/clear` to the call's final result. Every other result, including the `/clear` turn's own, is superseded by a later one.

In TypeScript, the SDK also emits an [`SDKConversationResetMessage`](/docs/en/agent-sdk/typescript#sdkconversationresetmessage) at each reset, so you can detect resets from the stream. In Python, the SDK likewise emits a `ConversationResetMessage`. Before Python SDK v0.2.137, the Python iterator dropped that message, so on those versions count the resets yourself from the `/clear` turns your app sends.

`maxBudgetUsd`, or `max_budget_usd` in Python, is compared against the same running total, so a `/clear` also starts the budget over.

## Get the total cost of a query

The result message, typed as [`SDKResultMessage`](/docs/en/agent-sdk/typescript#sdkresultmessage) in TypeScript and [`ResultMessage`](/docs/en/agent-sdk/python#resultmessage) in Python, marks the end of the agent loop for a `query()` call. It includes `total_cost_usd`, the cumulative estimated cost across all steps in that call. In Python the field is typed as optional, so check that it isn't `None` before you read it. Success and error results both carry it, though the final result of a [session crash](#recover-totals-after-a-session-crash) may carry it zeroed.

If you use sessions to make multiple `query()` calls, each result reflects only the cost of that individual call. In streaming input mode, read call totals as described in [Track costs in streaming input mode](#track-costs-in-streaming-input-mode).

The three result-level fields differ in what they count when the agent spawns [subagents](/docs/en/agent-sdk/subagents). Use `modelUsage`, or `model_usage` in Python, for whole-tree token accounting; the `usage` field undercounts as soon as nesting occurs.

| Field                        | Subagent activity                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `usage`                      | Excluded. Counts only the top-level agent loop, so tokens consumed inside subagents are not added |
| `total_cost_usd`             | Included. Counts subagent requests alongside the top-level loop                                   |
| `modelUsage` / `model_usage` | Included. Counts subagent requests alongside the top-level loop, broken down by model             |

The following examples iterate over the message stream from a `query()` call and print the total cost when the `result` message arrives:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  try {
    for await (const message of query({ prompt: "Summarize this project" })) {
      if (message.type === "result") {
        console.log(`Total cost: $${message.total_cost_usd}`);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result. If the
    // failure was an error result, it still carried total_cost_usd and the
    // branch above has already run; connection or process failures yield
    // no result message.
    console.error(`Session ended with an error: ${error}`);
  }
  ```

  ```python Python theme={null}
  from claude_agent_sdk import query, ResultMessage
  import asyncio


  async def main():
      try:
          async for message in query(prompt="Summarize this project"):
              if isinstance(message, ResultMessage):
                  print(f"Total cost: ${message.total_cost_usd or 0}")
      except Exception as error:
          # A single-shot query() raises after yielding an error result. If the
          # failure was an error result, the branch above has already run;
          # connection or process failures yield no result message.
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```
</CodeGroup>

To bound how much subagents can add to `total_cost_usd`, set the [depth, concurrency, and spend limits](/docs/en/agent-sdk/subagents#cap-subagent-depth-concurrency-and-spend) on the query.

## Track per-step and per-model usage

The examples in this section use TypeScript field names. In Python, the equivalent fields are [`AssistantMessage.usage`](/docs/en/agent-sdk/python#assistantmessage) and `AssistantMessage.message_id` for per-step usage, and [`ResultMessage.model_usage`](/docs/en/agent-sdk/python#resultmessage) for per-model breakdowns.

### Track per-step usage

Each assistant message contains a nested `BetaMessage` (accessed via `message.message`) with an `id` and `usage` object with token counts. When Claude uses tools in parallel, multiple messages share the same `id` with identical usage data. Track which IDs you've already counted and skip duplicates to avoid inflated totals.

<Warning>
  The deduplicated per-step values are accurate for input and cache tokens. Per-step `output_tokens` is a placeholder, so [read output tokens from the result message](#read-output-tokens-from-the-result-message).
</Warning>

The following example accumulates input tokens across all steps, counting each unique main-loop message ID only once and skipping subagent messages, and reads the output total from the result message, which covers the main loop:

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

const seenIds = new Set<string>();
let totalInputTokens = 0;
let resultOutputTokens = 0;

try {
  for await (const message of query({ prompt: "Summarize this project" })) {
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const msgId = message.message.id;

      // Parallel tool calls share the same ID, only count once
      if (!seenIds.has(msgId)) {
        seenIds.add(msgId);
        totalInputTokens += message.message.usage.input_tokens;
      }
    }
    if (message.type === "result") {
      // Per-step output_tokens is a placeholder; the result message
      // carries the accumulated output total.
      resultOutputTokens = message.usage.output_tokens;
    }
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result, so the
  // input total below still reflects the steps that ran before the failure.
  console.error(`Session ended with an error: ${error}`);
}

console.log(`Steps: ${seenIds.size}`);
console.log(`Input tokens: ${totalInputTokens}`);
console.log(`Output tokens: ${resultOutputTokens}`);
```

### Break down usage per model

The result message includes [`modelUsage`](/docs/en/agent-sdk/typescript#modelusage), a map of model name to per-model token counts and cost. This is useful when you run multiple models (for example, Haiku for subagents and Opus for the main agent) and want to see where tokens are going.

The following example runs a query and prints the cost and token breakdown for each model used:

```typescript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

try {
  for await (const message of query({ prompt: "Summarize this project" })) {
    if (message.type !== "result") continue;

    for (const [modelName, usage] of Object.entries(message.modelUsage)) {
      console.log(`${modelName}: $${usage.costUSD.toFixed(4)}`);
      console.log(`  Input tokens: ${usage.inputTokens}`);
      console.log(`  Output tokens: ${usage.outputTokens}`);
      console.log(`  Cache read: ${usage.cacheReadInputTokens}`);
      console.log(`  Cache creation: ${usage.cacheCreationInputTokens}`);
    }
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result. If the
  // failure was an error result, the per-model breakdown above has already
  // printed; connection or process failures yield no result message.
  console.error(`Session ended with an error: ${error}`);
}
```

## Accumulate costs across multiple calls

Each `query()` call returns its own `total_cost_usd`. The SDK doesn't provide a session-level total, so if your application makes multiple `query()` calls, for example in a multi-turn session or across different users, accumulate the totals yourself. In streaming input mode, read each call's total as described in [Track costs in streaming input mode](#track-costs-in-streaming-input-mode). For a call that ended in a crash, see [Recover totals after a session crash](#recover-totals-after-a-session-crash).

The following examples run two `query()` calls sequentially, add each call's `total_cost_usd` to a running total, and print both the per-call and combined cost:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Track cumulative cost across multiple query() calls
  let totalSpend = 0;

  const prompts = [
    "Read the files in src/ and summarize the architecture",
    "List all exported functions in src/auth.ts"
  ];

  for (const prompt of prompts) {
    try {
      for await (const message of query({ prompt })) {
        if (message.type === "result") {
          totalSpend += message.total_cost_usd;
          console.log(`This call: $${message.total_cost_usd}`);
        }
      }
    } catch (error) {
      // A single-shot query() throws after yielding an error result. If the
      // failure was an error result, this call's cost was already counted;
      // connection or process failures yield no result message. Continue
      // with the next prompt.
      console.error(`Call failed: ${error}`);
    }
  }

  console.log(`Total spend: $${totalSpend.toFixed(4)}`);
  ```

  ```python Python theme={null}
  from claude_agent_sdk import query, ResultMessage
  import asyncio


  async def main():
      # Track cumulative cost across multiple query() calls
      total_spend = 0.0

      prompts = [
          "Read the files in src/ and summarize the architecture",
          "List all exported functions in src/auth.ts",
      ]

      for prompt in prompts:
          try:
              async for message in query(prompt=prompt):
                  if isinstance(message, ResultMessage):
                      cost = message.total_cost_usd or 0
                      total_spend += cost
                      print(f"This call: ${cost}")
          except Exception as error:
              # A single-shot query() raises after yielding an error result. If
              # the failure was an error result, this call's cost was already
              # counted; connection or process failures yield no result message.
              # Continue with the next prompt.
              print(f"Call failed: {error}")

      print(f"Total spend: ${total_spend:.4f}")


  asyncio.run(main())
  ```
</CodeGroup>

## Handle errors, caching, and output token counts

For accurate cost tracking, account for the placeholder output count on assistant messages, the tokens a failed conversation consumed, and cache token pricing.

### Read output tokens from the result message

Claude Code builds each assistant message from the usage the API reported when the response began, so the message's `output_tokens` is only the count the API had reported at `message_start`, before the response was generated. One API response can produce several assistant messages, and every one of them carries that same placeholder.

The API reports the real output count at the end of the response, and Claude Code adds it to the result message. Read output tokens from the result's `usage`, or from `modelUsage` for a per-model breakdown.

To watch a response's output count grow while it streams, set `includePartialMessages`, or `include_partial_messages` in Python, and read `usage` from each `message_delta` stream event, typed as [`SDKPartialAssistantMessage`](/docs/en/agent-sdk/typescript#sdkpartialassistantmessage) in TypeScript and [`StreamEvent`](/docs/en/agent-sdk/python#streamevent) in Python.

### Track costs on failed conversations

Both success and error result messages include `usage` and `total_cost_usd`; in Python both fields are typed as optional, so check that they aren't `None` before you read them.

If a conversation fails midway, you still consumed tokens up to the point of failure. Read cost data from every result message, whether its `subtype` is `success` or one of the error subtypes. On some error results, `usage` reports less than the call spent:

* **`error_during_execution` after a [session crash](#recover-totals-after-a-session-crash)**: every cost field may be zeroed.
* **`error_max_budget_usd`**: `usage` leaves out the response that crossed the budget, while `total_cost_usd` and `modelUsage` include it.

Where you have the choice, account from `total_cost_usd` or `modelUsage` rather than `usage`.

### Recover totals after a session crash

When the Claude Code process crashes, it emits a final `error_during_execution` result and exits, in single-shot and streaming input mode alike. That result may carry zeroed `usage`, `total_cost_usd`, and `modelUsage`, so recover the call's totals from what arrived before it. Step 1 recovers the full totals whenever an earlier result exists; the fallback in step 2 recovers only the main loop's input and cache tokens.

1. Use the result of the turn before the crash. In streaming input mode, it holds the running total since the start of the call or since the last [`/clear`](#track-costs-in-streaming-input-mode). Go to step 2 instead when that result can't help you:
   * The call was single-shot, so no earlier result exists.
   * The crash happened on the first turn.
   * The turn before the crash was the `/clear` itself, so its result covers only the reset.
2. Sum the `usage` on the assistant messages instead, counting each API response once, as the [Track per-step usage](#track-per-step-usage) example does. In single-shot mode, sum all of them; in streaming input mode, sum the ones that arrived after the last result. This gives you the main loop's input and cache tokens. Subagent usage isn't recoverable this way, and neither are output tokens or USD cost, because [per-step `output_tokens` is a placeholder](#read-output-tokens-from-the-result-message).

### Track cache tokens

The Agent SDK automatically uses [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) to reduce costs on repeated content. You do not need to configure caching yourself. The usage object includes two additional fields for cache tracking:

* `cache_creation_input_tokens`: tokens used to create new cache entries (charged at a higher rate than standard input tokens).
* `cache_read_input_tokens`: tokens read from existing cache entries (charged at a reduced rate).

Track these separately from `input_tokens` to understand caching savings. In TypeScript, these fields are typed on the [`Usage`](/docs/en/agent-sdk/typescript#usage) object. In Python, they appear as keys in the [`ResultMessage.usage`](/docs/en/agent-sdk/python#resultmessage) dict (for example, `message.usage.get("cache_read_input_tokens", 0)`).

### Extend the prompt cache TTL to one hour

Your own turns fall in the [main conversation TTL bucket](/docs/en/prompt-caching#which-ttl-each-request-gets), together with the helpers Claude Code runs inline with them. The requests Claude Code makes outside that conversation, such as [subagents](/docs/en/agent-sdk/subagents), have a [separate TTL control](/docs/en/prompt-caching#choose-the-ttl-yourself).

Cache entries for your own turns use a 5-minute TTL by default when you authenticate with an API key or run on Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or [Claude Platform on AWS](/docs/en/claude-platform-on-aws). If your workload runs many short sessions against the same system prompt and context with gaps longer than 5 minutes between them, the cache expires between sessions and each new session pays full input price.

To request a 1-hour TTL on cache writes, set the [`ENABLE_PROMPT_CACHING_1H`](/docs/en/env-vars) environment variable. You can export it in your shell or container environment, or pass it through `options.env`.

The following example enables 1-hour TTL for an agent running on Amazon Bedrock. Because it sets `CLAUDE_CODE_USE_BEDROCK`, it requires working AWS credentials for [Amazon Bedrock](/docs/en/amazon-bedrock); without them the query fails.

<CodeGroup>
  ```python Python theme={null}
  from claude_agent_sdk import ClaudeAgentOptions, query
  import asyncio


  async def main():
      options = ClaudeAgentOptions(
          env={
              "CLAUDE_CODE_USE_BEDROCK": "1",
              "ENABLE_PROMPT_CACHING_1H": "1",
          },
      )

      async for message in query(prompt="Summarize this project", options=options):
          print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  const options = {
    env: {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: "1",
      ENABLE_PROMPT_CACHING_1H: "1",
    },
  };

  for await (const message of query({ prompt: "Summarize this project", options })) {
    console.log(message);
  }
  ```
</CodeGroup>

Cache writes with a 1-hour TTL are billed at a higher rate than 5-minute writes, so enabling this trades higher write cost for more cache reads. See [prompt caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) for details. On a Claude subscription within your plan's included usage, you get the 1-hour TTL on your own turns, and on some of the helper requests Claude Code makes beside them, without setting this variable, and Claude Code drops those turns to the 5-minute TTL once you're drawing on [usage credits](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans).

`ENABLE_PROMPT_CACHING_1H` asks for the 1-hour TTL on every request in both buckets. To choose a TTL for each bucket separately, use these controls instead. Each takes `5m` or `1h` and takes precedence over `ENABLE_PROMPT_CACHING_1H`:

* Main conversation: the `CLAUDE_CODE_PROMPT_CACHE_TTL` [environment variable](/docs/en/env-vars), or the [`promptCacheTtl`](/docs/en/settings-reference#promptcachettl) setting
* Everything else: the `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` environment variable, or the [`subagentPromptCacheTtl`](/docs/en/settings-reference#subagentpromptcachettl) setting

Setting `promptCacheTtl` to `1h` keeps the 1-hour cache on the main conversation while you're drawing on usage credits. For the full precedence order, see [choose the TTL yourself](/docs/en/prompt-caching#choose-the-ttl-yourself).

## Related documentation

* [TypeScript SDK Reference](/docs/en/agent-sdk/typescript) - Complete API documentation
* [SDK Overview](/docs/en/agent-sdk/overview) - Getting started with the SDK
* [SDK Permissions](/docs/en/agent-sdk/permissions) - Managing tool permissions
