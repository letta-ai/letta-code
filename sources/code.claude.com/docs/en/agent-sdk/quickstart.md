> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Quickstart

> Get started with the Python or TypeScript Agent SDK to build AI agents that work autonomously

Use the Agent SDK to build an AI agent that reads your code, finds bugs, and fixes them, all without manual intervention.

**What you'll do:**

1. Set up a project with the Agent SDK
2. Create a file with some buggy code
3. Run an agent that finds and fixes the bugs automatically

## Prerequisites

* **Node.js 18+** or **Python 3.10+**
* An **Anthropic account**. If you don't have one, [sign up here](https://platform.claude.com/).

## Setup

<Steps>
  <Step title="Create a project folder">
    Create a new directory for this quickstart:

    ```bash theme={null}
    mkdir my-agent
    cd my-agent
    ```

    For your own projects, you can run the SDK from any folder; it will have access to files in that directory and its subdirectories by default.
  </Step>

  <Step title="Install the SDK">
    Install the Agent SDK package for your language:

    <Tabs>
      <Tab title="TypeScript (new project)">
        ```bash theme={null}
        npm init -y
        npm pkg set type=module
        npm install @anthropic-ai/claude-agent-sdk
        npm install --save-dev tsx
        ```

        Setting `"type": "module"` in `package.json` lets your agent script use top-level `await`, and [tsx](https://tsx.hirok.io) runs TypeScript files directly. npm prints `added N packages` when the install succeeds.
      </Tab>

      <Tab title="TypeScript (existing project)">
        ```bash theme={null}
        npm install @anthropic-ai/claude-agent-sdk
        npm install --save-dev tsx
        ```

        [tsx](https://tsx.hirok.io) runs TypeScript files directly. If your project uses CommonJS, name your agent script `agent.mts` instead of `agent.ts`. The `.mts` extension makes tsx treat the file as an ES module, so top-level `await` works without converting your whole project to ES modules. Use `agent.mts` in place of `agent.ts` in the create and run steps later in this quickstart.
      </Tab>

      <Tab title="Python (uv)">
        [uv](https://docs.astral.sh/uv/) is a fast Python package manager that handles virtual environments automatically:

        ```bash theme={null}
        uv init
        uv add claude-agent-sdk
        ```
      </Tab>

      <Tab title="Python (pip)">
        Create and activate a virtual environment, then install the package.

        On macOS or Linux:

        ```bash theme={null}
        python3 -m venv .venv
        source .venv/bin/activate
        pip install claude-agent-sdk
        ```

        On Windows:

        ```powershell theme={null}
        py -m venv .venv
        .venv\Scripts\Activate.ps1
        pip install claude-agent-sdk
        ```

        If PowerShell blocks `Activate.ps1` with an execution policy error, run `Set-ExecutionPolicy -Scope Process RemoteSigned` first.
      </Tab>
    </Tabs>

    <Note>
      Both the TypeScript and Python SDKs bundle a native Claude Code binary, so most installs need no separate Claude Code install. Some installs have no bundled binary:

      * If pip installs the Python SDK's source distribution instead of a platform wheel, for example on ARM64 Windows, no binary is bundled. [Install Claude Code natively](/docs/en/setup#install-claude-code). The Python SDK finds it on your `PATH`.
      * The TypeScript SDK installs its binary through npm optional dependencies, so an install that skips them, for example `npm ci --omit=optional`, gets no binary even on a supported platform. Reinstall without skipping optional dependencies, or [install Claude Code natively](/docs/en/setup#install-claude-code) and set `pathToClaudeCodeExecutable` to its path.
    </Note>
  </Step>

  <Step title="Set your API key">
    Get an API key from the [Claude Console](https://platform.claude.com/), then set it as an environment variable in the shell where you'll run your agent:

    <Tabs>
      <Tab title="macOS / Linux">
        ```bash theme={null}
        export ANTHROPIC_API_KEY=your-api-key
        ```
      </Tab>

      <Tab title="Windows (PowerShell)">
        ```powershell theme={null}
        $env:ANTHROPIC_API_KEY = "your-api-key"
        ```
      </Tab>
    </Tabs>

    The SDK reads the key from the environment of the process that runs your agent; it doesn't load `.env` files automatically. If you keep the key in a `.env` file, load it yourself, for example with the `dotenv` package, before calling the SDK.

    The SDK also supports authentication via third-party API providers:

    * **Amazon Bedrock**: set `CLAUDE_CODE_USE_BEDROCK=1` environment variable and configure AWS credentials
    * **Claude Platform on AWS**: set `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` and `ANTHROPIC_AWS_WORKSPACE_ID`, then configure AWS credentials
    * **Google Cloud's Agent Platform**: set `CLAUDE_CODE_USE_VERTEX=1` environment variable and configure Google Cloud credentials
    * **Microsoft Foundry**: set `CLAUDE_CODE_USE_FOUNDRY=1` environment variable and configure Azure credentials

    See the setup guides for [Amazon Bedrock](/docs/en/amazon-bedrock), [Claude Platform on AWS](/docs/en/claude-platform-on-aws), [Google Cloud's Agent Platform](/docs/en/google-vertex-ai), or [Microsoft Foundry](/docs/en/microsoft-foundry) for details.

    <Note>
      Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead.
    </Note>
  </Step>
</Steps>

## Create a buggy file

This quickstart walks you through building an agent that can find and fix bugs in code. First, you need a file with some intentional bugs for the agent to fix. Create `utils.py` in the `my-agent` directory and paste the following code:

```python theme={null}
def calculate_average(numbers):
    total = 0
    for num in numbers:
        total += num
    return total / len(numbers)


def get_user_name(user):
    return user["name"].upper()
```

This code has two bugs:

1. `calculate_average([])` crashes with division by zero
2. `get_user_name(None)` crashes with a TypeError

## Build an agent that finds and fixes bugs

Create `agent.py` if you're using the Python SDK, or `agent.ts` for TypeScript. Use `agent.mts` instead if your existing project uses CommonJS:

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, ResultMessage


  async def main():
      # Agentic loop: streams messages as Claude works
      async for message in query(
          prompt="Review utils.py for bugs that would cause crashes. Fix any issues you find.",
          options=ClaudeAgentOptions(
              allowed_tools=["Read", "Edit", "Glob"],  # Auto-approve these tools
              permission_mode="acceptEdits",  # Auto-approve file edits
          ),
      ):
          # Print human-readable output
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if hasattr(block, "text"):
                      print(block.text)  # Claude's reasoning
                  elif hasattr(block, "name"):
                      print(f"Tool: {block.name}")  # Tool being called
          elif isinstance(message, ResultMessage):
              print(f"Done: {message.subtype}")  # Final result


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Agentic loop: streams messages as Claude works
  for await (const message of query({
    prompt: "Review utils.py for bugs that would cause crashes. Fix any issues you find.",
    options: {
      allowedTools: ["Read", "Edit", "Glob"], // Auto-approve these tools
      permissionMode: "acceptEdits" // Auto-approve file edits
    }
  })) {
    // Print human-readable output
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          console.log(block.text); // Claude's reasoning
        } else if ("name" in block) {
          console.log(`Tool: ${block.name}`); // Tool being called
        }
      }
    } else if (message.type === "result") {
      console.log(`Done: ${message.subtype}`); // Final result
    }
  }
  ```
</CodeGroup>

This code has three main parts:

1. **`query`**: the main entry point that creates the agentic loop. It returns an async iterator, so you use `async for` to stream messages as Claude works. See the full API in the [Python](/docs/en/agent-sdk/python#query) or [TypeScript](/docs/en/agent-sdk/typescript#query) SDK reference.

2. **`prompt`**: what you want Claude to do. Claude figures out which tools to use based on the task.

3. **`options`**: configuration for the agent. This example uses `allowedTools` to pre-approve `Read`, `Edit`, and `Glob`, and `permissionMode: "acceptEdits"` to auto-approve file changes. Other options include `systemPrompt`, `mcpServers`, and more. See all options for [Python](/docs/en/agent-sdk/python#claudeagentoptions) or [TypeScript](/docs/en/agent-sdk/typescript#options).

The `async for` loop keeps running as Claude thinks, calls tools, observes results, and decides what to do next. Each iteration yields a message: Claude's reasoning, a tool call, a tool result, or the final outcome. The SDK handles the orchestration, tool execution, context management, and retries, so you consume the stream. The loop ends when Claude finishes the task or hits an error.

The message handling inside the loop filters for human-readable output. Without filtering, you'd see raw message objects including system initialization and internal state, which is useful for debugging but noisy otherwise.

<Note>
  This example uses streaming to show progress in real-time. If you don't need live output (e.g., for background jobs or CI pipelines), you can collect all messages at once. See [Streaming vs. single-turn mode](/docs/en/agent-sdk/streaming-vs-single-mode) for details.
</Note>

### Run your agent

Your agent is ready. Run it with the following command:

<Tabs>
  <Tab title="TypeScript">
    ```bash theme={null}
    npx tsx agent.ts
    ```

    If you named your script `agent.mts`, run `npx tsx agent.mts` instead.
  </Tab>

  <Tab title="Python (uv)">
    ```bash theme={null}
    uv run agent.py
    ```
  </Tab>

  <Tab title="Python (pip)">
    With your virtual environment still activated:

    ```bash theme={null}
    python agent.py
    ```
  </Tab>
</Tabs>

As it works, the agent prints its reasoning and each tool it calls, ending with `Done: success`. After running, check `utils.py`. You'll see defensive code handling empty lists and null users. Your agent autonomously:

1. **Read** `utils.py` to understand the code
2. **Analyzed** the logic and identified edge cases that would crash
3. **Edited** the file to add proper error handling

This is what makes the Agent SDK different: Claude executes tools directly instead of asking you to implement them.

<Note>
  If you see an authentication error such as `Not logged in` or `Invalid API key`, make sure you've set the `ANTHROPIC_API_KEY` environment variable in the shell where you run your agent. The SDK doesn't load `.env` files automatically. See the [full troubleshooting guide](/docs/en/troubleshooting) for more help.
</Note>

### Try other prompts

Now that your agent is set up, try some different prompts:

* `"Add docstrings to all functions in utils.py"`
* `"Add type hints to all functions in utils.py"`
* `"Create a README.md documenting the functions in utils.py"`

### Customize your agent

You can modify your agent's behavior by changing the options. Here are a few examples:

**Add web search capability:**

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      allowed_tools=["Read", "Edit", "Glob", "WebSearch"], permission_mode="acceptEdits"
  )
  ```

  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      allowedTools: ["Read", "Edit", "Glob", "WebSearch"],
      permissionMode: "acceptEdits"
    }
  };
  ```
</CodeGroup>

**Give Claude a custom system prompt:**

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      allowed_tools=["Read", "Edit", "Glob"],
      permission_mode="acceptEdits",
      system_prompt="You are a senior Python developer. Always follow PEP 8 style guidelines.",
  )
  ```

  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      allowedTools: ["Read", "Edit", "Glob"],
      permissionMode: "acceptEdits",
      systemPrompt: "You are a senior Python developer. Always follow PEP 8 style guidelines."
    }
  };
  ```
</CodeGroup>

**Run commands in the terminal:**

<CodeGroup>
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      allowed_tools=["Read", "Edit", "Glob", "Bash"], permission_mode="acceptEdits"
  )
  ```

  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      allowedTools: ["Read", "Edit", "Glob", "Bash"],
      permissionMode: "acceptEdits"
    }
  };
  ```
</CodeGroup>

With `Bash` enabled, try: `"Write unit tests for utils.py, run them, and fix any failures"`

## Key concepts

**Tools** control what your agent can do:

| Tools                                  | What the agent can do   |
| -------------------------------------- | ----------------------- |
| `Read`, `Glob`, `Grep`                 | Read-only analysis      |
| `Read`, `Edit`, `Glob`                 | Analyze and modify code |
| `Read`, `Edit`, `Bash`, `Glob`, `Grep` | Full automation         |

**Permission modes** control how much human oversight you want. The SDK evaluates the active mode together with your allow and deny rules in a fixed order, described in [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated). For the full list of modes, their behavior, and when to use each, see [Permission mode in How the agent loop works](/docs/en/agent-sdk/agent-loop#permission-mode).

## Next steps

Now that you've created your first agent, learn how to extend its capabilities and tailor it to your use case:

* **[Permissions](/docs/en/agent-sdk/permissions)**: control what your agent can do and when it needs approval
* **[Hooks](/docs/en/agent-sdk/hooks)**: run custom code before or after tool calls
* **[Sessions](/docs/en/agent-sdk/sessions)**: build multi-turn agents that maintain context
* **[MCP servers](/docs/en/agent-sdk/mcp)**: connect to databases, browsers, APIs, and other external systems
* **[Hosting](/docs/en/agent-sdk/hosting)**: deploy agents to Docker, cloud, and CI/CD
* **[Example agents](https://github.com/anthropics/claude-agent-sdk-demos)**: see complete examples: email assistant, research agent, and more
