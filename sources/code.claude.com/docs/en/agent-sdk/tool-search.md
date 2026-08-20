> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Scale to many tools with tool search

> Scale your agent to thousands of tools by discovering and loading only what's needed, on demand.

Tool search enables your agent to work with hundreds or thousands of tools by dynamically discovering and loading them on demand. Instead of loading all tool definitions into the context window upfront, the agent searches your tool catalog and loads only the tools it needs.

This approach solves two challenges as tool libraries scale:

* **Context efficiency:** Tool definitions can consume large portions of the context window (50 tools can use 10-20K tokens), leaving less room for actual work.
* **Tool selection accuracy:** Tool selection accuracy degrades with more than 30-50 tools loaded at once.

## How tool search works

Tool search is on by default, with the exceptions listed in [Configure tool search](#configure-tool-search).

When it is active, tool definitions are withheld from the context window. The agent receives a summary of available tools and searches for relevant ones when the task requires a capability not already loaded. Up to five of the most relevant tools are loaded into context by default, where they stay available for subsequent turns. If the conversation is long enough that the SDK compacts earlier messages to free space, previously discovered tools may be removed, and the agent searches again as needed.

Tool search adds one extra round-trip the first time Claude discovers a tool (the search step), but for large tool sets this is offset by smaller context on every turn. With fewer than \~10 tools whose definitions fit comfortably in the context window, loading everything upfront is typically faster.

For details on the underlying API mechanism, see [Tool search in the API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

<Note>
  Tool search isn't supported on Microsoft Foundry [deployments hosted on Azure](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry#hosting-options), which reject it server-side: the SDK detects the rejection and loads tool definitions upfront for that deployment instead. [`ENABLE_TOOL_SEARCH`](#configure-tool-search) can't override this, since the rejection comes from the deployment itself.
</Note>

## Configure tool search

Tool search is on by default. For models on the SDK's unsupported-model list, the SDK loads tool definitions upfront instead, and no `ENABLE_TOOL_SEARCH` value overrides that. On Google Cloud's Agent Platform, the SDK decides by model generation:

* **Claude Opus 4.5, Sonnet 4.5, Haiku 4.5, and later**: tool search is on by default.
* **Earlier Agent Platform models**: the SDK loads tool definitions upfront, because their serving stacks reject the required beta header. `ENABLE_TOOL_SEARCH` can't override this.

Before Claude Code v2.1.221, the SDK disabled tool search for all models on Google Cloud's Agent Platform unless you set `ENABLE_TOOL_SEARCH`.

The SDK also disables tool search when `ANTHROPIC_BASE_URL` points to a non-first-party host, since most proxies don't forward `tool_reference` blocks. You can override that default with the `ENABLE_TOOL_SEARCH` environment variable:

| Value    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                            |
| :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (unset)  | Tool search is on. Tool definitions are deferred and discovered on demand. Falls back to loading upfront on Google Cloud's Agent Platform models earlier than the Claude 4.5 generation, a non-first-party `ANTHROPIC_BASE_URL`, or a Microsoft Foundry deployment hosted on Azure.                                                                                                                                 |
| `true`   | Tool search is always on, except on a Microsoft Foundry deployment hosted on Azure, where the server-side rejection still forces upfront loading, and on Google Cloud's Agent Platform models earlier than the Claude 4.5 generation, where the SDK keeps loading tool definitions upfront. The SDK sends the beta header through proxies, and requests fail on proxies that don't support `tool_reference` blocks. |
| `auto`   | Counts the tokens in the tool definitions that tool search can defer and compares the total against the model's context window. When the total reaches 10% of the window, tool search activates. Below that, the SDK loads every tool definition into context upfront.                                                                                                                                              |
| `auto:N` | Same as `auto` with a custom percentage. `auto:5` activates when those definitions reach 5% of the context window. Lower values activate sooner.                                                                                                                                                                                                                                                                    |
| `false`  | Tool search is off. All tool definitions are loaded into context on every turn.                                                                                                                                                                                                                                                                                                                                     |

Setting [`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`](/docs/en/env-vars) keeps tool search off. You can't override it by setting `ENABLE_TOOL_SEARCH` yourself. Your organization can keep tool search on through [managed settings](/docs/en/settings#settings-files), on Claude Code v2.1.227 or later. [Disable pre-release capabilities](/docs/en/llm-gateway-protocol#disable-pre-release-capabilities) covers where the override applies and what the variable strips.

Tool search applies to all registered tools, whether they come from remote MCP servers or [custom SDK MCP servers](/docs/en/agent-sdk/custom-tools). When you use `auto`, the SDK counts every definition that tool search can defer toward one combined threshold: each MCP tool that isn't marked [`alwaysLoad`](/docs/en/mcp#exempt-a-server-from-deferral), from any server, plus the built-in tools that load on demand. The SDK always loads core built-in tools such as Bash, Read, and Edit upfront and doesn't count them toward the threshold.

Set the value in the `env` option on `query()`. In TypeScript, `env` replaces the subprocess environment, so spread `...process.env` to keep inherited variables. In Python, `env` is merged on top of the inherited environment. This example connects to a remote MCP server that exposes many tools, pre-approves all of them with a wildcard, and uses `auto:5` so tool search activates when the definitions it can defer reach 5% of the context window:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  try {
    for await (const message of query({
      prompt: "Find and run the appropriate database query",
      options: {
        mcpServers: {
          "enterprise-tools": {
            // Connect to a remote MCP server
            type: "http",
            url: "https://tools.example.com/mcp"
          }
        },
        allowedTools: ["mcp__enterprise-tools__*"], // Wildcard pre-approves all tools from this server
        env: {
          ...process.env, // env replaces the subprocess environment, so keep inherited variables
          ENABLE_TOOL_SEARCH: "auto:5" // Activate tool search when deferrable definitions reach 5% of context
        }
      }
    })) {
      if (message.type === "result" && message.subtype === "success") {
        console.log(message.result);
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result
    console.log(`Session ended with an error: ${error}`);
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "enterprise-tools": {
                  "type": "http",
                  "url": "https://tools.example.com/mcp",
              }
          },
          allowed_tools=[
              "mcp__enterprise-tools__*"
          ],  # Wildcard pre-approves all tools from this server
          env={
              "ENABLE_TOOL_SEARCH": "auto:5"  # Activate tool search when deferrable definitions reach 5% of context
          },
      )

      try:
          async for message in query(
              prompt="Find and run the appropriate database query",
              options=options,
          ):
              if isinstance(message, ResultMessage) and message.subtype == "success":
                  print(message.result)
      except Exception as error:
          # A single-shot query() raises after yielding an error result
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```
</CodeGroup>

To run this example, replace `https://tools.example.com/mcp` with the URL of your own MCP server. On success the result text prints to the console.

Because this is a single-shot `query()` call, the SDK raises after yielding an error result, so the example wraps the loop in a try block. To see why a run failed, check the result message's `subtype`, such as `error_during_execution`, inside the loop. For more on result messages, see [Handle the result](/docs/en/agent-sdk/agent-loop#handle-the-result).

## Optimize tool discovery

The search mechanism matches queries against tool names and descriptions. Names like `search_slack_messages` surface for a wider range of requests than `query_slack`. Descriptions with specific keywords ("Search Slack messages by keyword, channel, or date range") match more queries than generic ones ("Query Slack").

You can also add a system prompt section listing available tool categories. This gives the agent context about what kinds of tools are available to search for. Pass the text through the `systemPrompt` option in TypeScript or `system_prompt` in Python, using the `claude_code` preset with `append`, which adds your text to the preset's prompt instead of replacing it:

<CodeGroup>
  ```typescript TypeScript theme={null}
  options: {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "You can search for tools to interact with Slack, GitHub, and Jira."
    }
  }
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      system_prompt={
          "type": "preset",
          "preset": "claude_code",
          "append": "You can search for tools to interact with Slack, GitHub, and Jira.",
      }
  )
  ```
</CodeGroup>

For the full set of system prompt options, see [Modifying system prompts](/docs/en/agent-sdk/modifying-system-prompts).

## Limits

* **Maximum tools:** 10,000 tools in your catalog
* **Search results:** returns up to five most relevant tools per search by default
* **Model support:** Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5, and later models; see [model compatibility in the API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#model-compatibility) for the current list. The same minimums apply on Google Cloud's Agent Platform.

## Related documentation

* [Tool search in the API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): Full API documentation for tool search, including custom implementations
* [Connect MCP servers](/docs/en/agent-sdk/mcp): Connect to external tools via MCP servers
* [Custom tools](/docs/en/agent-sdk/custom-tools): Build your own tools with SDK MCP servers
* [TypeScript SDK reference](/docs/en/agent-sdk/typescript): Full API reference
* [Python SDK reference](/docs/en/agent-sdk/python): Full API reference
