> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Configure your agent

> Configure Agent SDK sessions: compose the options object, set the model, environment, and limits, and find each feature option's page.

An Agent SDK session reads configuration from settings files, environment variables, and the `options` object you pass when you start it. This page shows how to compose the `options` object and what settings files and environment variables control.

For every option's type and default, see the [`Options`](https://code.claude.com/docs/en/agent-sdk/typescript#options) (TypeScript) and [`ClaudeAgentOptions`](https://code.claude.com/docs/en/agent-sdk/python#claudeagentoptions) (Python) references.

## Pass options to a session

Every `query()` call accepts an options object: `Options` in TypeScript, `ClaudeAgentOptions` in Python. Each field is optional, and a session started with no options runs with the SDK's defaults. The example below configures a read-only session that summarizes a project's open TODOs. Pairs read as TypeScript / Python where the spellings differ:

* **`model`**: picks the model
* **`allowedTools` / `allowed_tools`**: pre-approves a read-only tool list
* **`maxTurns` / `max_turns`**: caps the turn count
* **`cwd`**: sets the working directory

```typescript TypeScript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Summarize the open TODOs in this repo",
  options: {
    model: "claude-sonnet-5",
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 8,
    cwd: "/path/to/repo",
  },
})) {
  if (message.type === "result" && message.subtype === "success" && !message.is_error) {
    console.log(message.result);
  }
}
```

```python Python theme={null}
import asyncio

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

async def main():
    options = ClaudeAgentOptions(
        model="claude-sonnet-5",
        allowed_tools=["Read", "Glob", "Grep"],
        max_turns=8,
        cwd="/path/to/repo",
    )

    async for message in query(
        prompt="Summarize the open TODOs in this repo",
        options=options,
    ):
        if isinstance(message, ResultMessage) and not message.is_error:
            print(message.result)

asyncio.run(main())
```

Point `cwd` at one of your own projects and run the example. The summary of that project's open TODOs prints when the result message arrives.

`allowedTools` (TypeScript) or `allowed_tools` (Python) pre-approves the listed tools, so calls to them run without stopping for approval. Tools outside the list stay available. When Claude calls an unlisted tool, the permission mode decides whether the call runs. For more information, see [Allow and deny rules](https://code.claude.com/docs/en/agent-sdk/permissions.md#allow-and-deny-rules).

## Load settings files

Settings files supply configuration beyond the options object. Two options control how they load:

* **`settingSources` / `setting_sources`**: controls which filesystem sources load: user, project, and local. Settings files and CLAUDE.md files arrive through these sources.
* **`settings`**: loads a settings file path or an inline JSON string in either language, and TypeScript also accepts a settings object. Whichever form you pass overrides user, project, and local filesystem settings; only managed policy settings rank higher. The references document the full precedence order under [Settings precedence](https://code.claude.com/docs/en/agent-sdk/typescript.md#settings-precedence) for TypeScript and [Settings precedence](https://code.claude.com/docs/en/agent-sdk/python.md#settings-precedence) for Python.

Pass `[]` to disable user, project, and local settings. For more information, see [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md).

## Choose a model

Unless the `model` option, your settings, or your environment selects a model, a new session starts on [Claude Code's default model](https://code.claude.com/docs/en/model-config.md#default-model-setting). For the order of those sources, see [Setting your model](https://code.claude.com/docs/en/model-config.md#setting-your-model). Set `model` to pin a specific model, or to pick a smaller one for faster, cheaper agents. The value takes a model alias or a full model name; aliases and the versions they resolve to are listed under [Model aliases](https://code.claude.com/docs/en/model-config.md#model-aliases).

Set `fallbackModel` (TypeScript) or `fallback_model` (Python) to name a backup model. When the primary is overloaded or unavailable, the session switches to the backup. The primary is retried at the start of each user turn, so the session returns to it once the outage passes.

In either language, the option accepts a single model or a comma-separated list of backups. For the order and the chain cap, see [Fallback model chains](https://code.claude.com/docs/en/model-config.md#fallback-model-chains). In TypeScript, a fallback equal to `model` throws an error at startup.

The examples below show a fallback list in TypeScript and a single fallback in Python:

```typescript TypeScript theme={null}
const options = {
  model: "claude-fable-5",
  fallbackModel: "claude-opus-5,claude-sonnet-5",
};
```

```python Python theme={null}
options = ClaudeAgentOptions(
    model="claude-fable-5",
    fallback_model="claude-opus-5",
)
```

> [!NOTE]
>
> The [Messages API](https://platform.claude.com/docs/en/api/messages) request parameters `temperature`, `top_p`, and `max_tokens` have no fields on the options object in either language. Set the [effort level](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#effort-level) or a [spend cap](#limit-turns-and-spend) instead, or call the Messages API when you need those parameters directly.

## Set environment variables

The `env` option sets environment variables for the Claude Code process that runs your session. Whether your values replace the inherited environment or merge over it differs by language:

* **TypeScript**: `env` replaces the subprocess environment
* **Python**: the SDK merges your values over the inherited environment, and your values override the inherited ones

In TypeScript, spread `process.env` into `env` to keep inherited variables such as `PATH`, `HOME`, and `ANTHROPIC_API_KEY`. When you leave `env` unset, the subprocess inherits your environment in both languages.

The example routes API traffic through a gateway by setting `ANTHROPIC_BASE_URL`.

```typescript TypeScript theme={null}
const options = {
  env: { ...process.env, ANTHROPIC_BASE_URL: "https://gateway.example.com" },
};
```

```python Python theme={null}
options = ClaudeAgentOptions(
    env={"ANTHROPIC_BASE_URL": "https://gateway.example.com"},
)
```

The variables you pass can also configure Claude Code itself. For the variables the Claude Code process reads, see [Environment variables](https://code.claude.com/docs/en/env-vars.md). To tune API timeouts and stall detection this way, follow the Handle slow or stalled API responses section in the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript.md#handle-slow-or-stalled-api-responses) or the [Python reference](https://code.claude.com/docs/en/agent-sdk/python.md#handle-slow-or-stalled-api-responses).

## Set the working directory

Set `cwd` to run the session in a specific directory. When you leave `cwd` unset, the session runs in your process's working directory. Neither SDK has a setter for `cwd`. To run in a different directory, start another session with that `cwd`.

Claude Code reads the working directory to determine:

* **Project settings and hooks**: which project's [settings and hooks load](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md)
* **Skills**: where [session skills are discovered](https://code.claude.com/docs/en/agent-sdk/skills.md)
* **Session storage**: which project a [stored session belongs to](https://code.claude.com/docs/en/agent-sdk/session-storage.md)

To let tools reach files outside the working directory, add paths with `additionalDirectories` (TypeScript) or `add_dirs` (Python). For the scope of that grant, see [Additional directories grant file access, not configuration](https://code.claude.com/docs/en/permissions.md#additional-directories-grant-file-access-not-configuration).

## Limit turns and spend

Cap turns and spend with `maxTurns` / `max_turns` and `maxBudgetUsd` / `max_budget_usd`. Both caps are off when unset. When a session hits a cap, the run ends with a result message whose subtype names the cap, `error_max_turns` or `error_max_budget_usd`. What happens next differs by input mode:

* **Single-shot `query()`**: the SDK yields the cap result and then raises, so wrap the loop in a try block to continue past the error
* **Streaming input**: the session stays alive past a cap result, and the max-turns count starts over for each queued message. The budget total accumulates across messages, and once spend reaches the cap, later messages in the same conversation end with the same budget result. A [`/clear`](https://code.claude.com/docs/en/agent-sdk/cost-tracking) starts the budget over

The two caps treat `0` differently:

* **`maxTurns` / `max_turns`**: `0` runs the session without a turn limit, the same as leaving the option unset
* **`maxBudgetUsd` / `max_budget_usd`**: the CLI rejects `0` as an invalid amount at startup, and the session never runs

For more information about both caps, including subagent spend, see [Turns and budget](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#turns-and-budget).

## Change configuration mid-session

When you start a session with [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md), you can switch its model and permission mode while it runs. Where you call the setters differs by language:

* **TypeScript**: methods on the object `query()` returns
* **Python**: methods on [`ClaudeSDKClient`](https://code.claude.com/docs/en/agent-sdk/python#claudesdkclient), since `query()` returns a plain iterator without control methods

Both languages have the same setters:

* **`setModel()` / `set_model()`**: switches the model. Call it with no model to switch to [Claude Code's default model](https://code.claude.com/docs/en/model-config.md#default-model-setting) rather than the `model` you passed in options. If the session is in auto mode and you switch to a model that auto mode doesn't support, the session changes to `default` mode. To return to auto mode, see [Auto mode (`auto`)](https://code.claude.com/docs/en/agent-sdk/permissions#auto-mode-auto).
* **`setPermissionMode()` / `set_permission_mode()`**: switches the permission mode

TypeScript also has `applyFlagSettings()` and `updateSettings()`:

* **`applyFlagSettings()`**: applies settings at runtime, as in `await session.applyFlagSettings({ effortLevel: "high" })`. The method takes settings file keys rather than options fields, so check the [`applyFlagSettings()` reference](https://code.claude.com/docs/en/agent-sdk/typescript#applyflagsettings) for the schema and for which keys take effect mid-session.
* **`updateSettings()`**: writes one allowlisted key to a settings file. The [`updateSettings()` reference](https://code.claude.com/docs/en/agent-sdk/typescript#updatesettings) names the key each source accepts and the version floors.
  * Pass `"localSettings"` to write the project's local settings file, as in `await session.updateSettings("localSettings", { outputStyle: "Explanatory" })`. The written key takes effect on the session's next request and persists for later sessions that load `local` settings.
  * Pass `"userSettings"` to write `effortLevel`, the only key that source accepts. Claude Code saves it as the default effort level for the session's current model, and the running session's effort doesn't change.

The example below runs a two-turn session, changes the configuration between the turns, and prints the model that answered each turn. In TypeScript, the prompt stream holds the second message until the setters have run, and the second turn runs on the new model.

```typescript TypeScript theme={null}
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

// Hold the second prompt until the setters have run.
let startSecondTurn!: () => void;
const secondTurnReady = new Promise<void>((resolve) => {
  startSecondTurn = resolve;
});

async function* turnPrompts(): AsyncGenerator<SDKUserMessage, void> {
  yield userMessage("Reply with exactly: ready");
  await secondTurnReady;
  yield userMessage("Reply with exactly: done");
}

const session = query({
  prompt: turnPrompts(),
  options: {
    model: "claude-sonnet-5",
  },
});

let turnModel = "";
let completedTurns = 0;

for await (const message of session) {
  if (message.type === "assistant") {
    turnModel = message.message.model;
  } else if (message.type === "result") {
    completedTurns += 1;
    if (completedTurns === 1) {
      console.log(`First turn model: ${turnModel}`);
      await session.setModel("claude-opus-5");
      await session.setPermissionMode("acceptEdits");
      startSecondTurn();
    } else {
      console.log(`Second turn model: ${turnModel}`);
      break;
    }
  }
}
```

```python Python theme={null}
import asyncio

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient

async def main():
    options = ClaudeAgentOptions(model="claude-sonnet-5")

    async with ClaudeSDKClient(options=options) as client:
        await client.query("Reply with exactly: ready")
        first_model = ""
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                first_model = message.model

        await client.set_model("claude-opus-5")
        await client.set_permission_mode("acceptEdits")

        await client.query("Reply with exactly: done")
        second_model = ""
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                second_model = message.model

    print(f"First turn model: {first_model}")
    print(f"Second turn model: {second_model}")

asyncio.run(main())
```

On the Claude API, the program prints `First turn model: claude-sonnet-5`, then `Second turn model: claude-opus-5` after the switch.

> [!NOTE]
>
> Each model has its own prompt cache, so after a mid-session switch the next request recomputes the full conversation uncached at the new model's rates. For more information, see [Switching models](https://code.claude.com/docs/en/prompt-caching.md#switching-models).

## Configure specific features

The table below maps each option to the feature it configures. For options this page doesn't cover, see the [TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md#options) and [Python](https://code.claude.com/docs/en/agent-sdk/python.md#claudeagentoptions) references. If you know your goal but not which option serves it, start from [Choose the right feature](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md#choose-the-right-feature).

| TypeScript | Python | Controls | Covered in |
| - | - | - | - |
| `permissionMode` | `permission_mode` | What the agent can do without approval | [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md) |
| `allowedTools` | `allowed_tools` | Which tool calls are pre-approved | [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md) |
| `canUseTool` | `can_use_tool` | Your approval callback for tool calls | [Handle tool approval requests](https://code.claude.com/docs/en/agent-sdk/user-input.md#handle-tool-approval-requests) |
| `systemPrompt` | `system_prompt` | The agent's instructions | [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md) |
| `settingSources` | `setting_sources` | Which filesystem settings load | [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features.md) |
| `mcpServers` | `mcp_servers` | External tool servers | [Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp.md) |
| `agents` | `agents` | Subagent definitions | [Subagents](https://code.claude.com/docs/en/agent-sdk/subagents.md) |
| `hooks` | `hooks` | Callbacks at lifecycle points | [Hooks](https://code.claude.com/docs/en/agent-sdk/hooks.md) |
| `skills` | `skills` | Which skills load | [Extend agents with skills](https://code.claude.com/docs/en/agent-sdk/skills.md) |
| `plugins` | `plugins` | Which plugins load | [Plugins](https://code.claude.com/docs/en/agent-sdk/plugins.md) |
| `outputFormat` | `output_format` | Structured output schemas | [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs.md) |
| `resume` | `resume` | Continuing a stored session | [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) |
| `forkSession` | `fork_session` | Branching a session | [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) |
| `sessionStore` | `session_store` | External session persistence | [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage.md) |
| `enableFileCheckpointing` | `enable_file_checkpointing` | Rewindable file edits | [File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md) |
| `effort` | `effort` | How much work Claude puts into responses | [Effort level](https://code.claude.com/docs/en/agent-sdk/agent-loop.md#effort-level) |
| `sandbox` | `sandbox` | Sandbox behavior for tool execution | [TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md#sandbox-configuration) and [Python](https://code.claude.com/docs/en/agent-sdk/python.md#sandbox-configuration) references, with deployment context in [Secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment.md) |

## Next steps

To see configuration composed into working agents:

* **[Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md)**: build and run a first agent end to end
* **[Examples](https://code.claude.com/docs/en/agent-sdk/examples.md)**: find a complete, runnable project or a guided Claude Cookbook recipe that matches what you want to build
* **[Multi-tenant isolation](https://code.claude.com/docs/en/agent-sdk/hosting.md#multi-tenant-isolation)**: isolate each tenant's settings and memory with `settingSources` / `setting_sources`, `env`, and `cwd`
