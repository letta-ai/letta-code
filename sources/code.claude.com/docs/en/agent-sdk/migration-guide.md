> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Migrate to Claude Agent SDK

> Guide for migrating the Claude Code TypeScript and Python SDKs to the Claude Agent SDK

## Overview

The Claude Code SDK has been renamed to the **Claude Agent SDK** and its documentation has been reorganized. This change reflects the SDK's broader capabilities for building AI agents beyond just coding tasks.

## What's Changed

| Aspect                     | Old                         | New                                                                      |
| :------------------------- | :-------------------------- | :----------------------------------------------------------------------- |
| **Package Name (TS/JS)**   | `@anthropic-ai/claude-code` | `@anthropic-ai/claude-agent-sdk`                                         |
| **Python Package**         | `claude-code-sdk`           | `claude-agent-sdk`                                                       |
| **Documentation Location** | Claude Code docs            | Claude Code docs → dedicated [Agent SDK](/docs/en/agent-sdk/overview) section |

## Migration Steps

### For TypeScript/JavaScript Projects

**1. Uninstall the old package:**

```bash theme={null}
npm uninstall @anthropic-ai/claude-code
```

**2. Install the new package:**

```bash theme={null}
npm install @anthropic-ai/claude-agent-sdk
```

**3. Update your imports:**

Change all imports from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`:

```typescript theme={null}
// Before
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-code";

// After
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
```

**4. Update package.json dependencies:**

If you have the package listed in your `package.json`, update it:

Before:

```json theme={null}
{
  "dependencies": {
    "@anthropic-ai/claude-code": "^0.0.42"
  }
}
```

After:

```json theme={null}
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.0"
  }
}
```

**5. Review [breaking changes](#breaking-changes)**

Make any code changes needed to complete the migration.

### For Python Projects

**1. Uninstall the old package:**

```bash theme={null}
pip uninstall -y claude-code-sdk
```

If the old package isn't installed, pip prints `WARNING: Skipping claude-code-sdk as it is not installed.` That's expected and you can continue to the next step.

**2. Install the new package:**

```bash theme={null}
pip install claude-agent-sdk
```

If `claude-code-sdk` is listed in your `requirements.txt` or `pyproject.toml`, replace it with `claude-agent-sdk`.

**3. Update your imports:**

Change all imports from `claude_code_sdk` to `claude_agent_sdk`:

```python theme={null}
# Before
from claude_code_sdk import query, ClaudeCodeOptions

# After
from claude_agent_sdk import query, ClaudeAgentOptions
```

**4. Review [breaking changes](#breaking-changes)**

Make any code changes needed to complete the migration.

## Breaking changes

<Warning>
  To improve isolation and explicit configuration, Claude Agent SDK v0.1.0 introduces breaking changes for users migrating from Claude Code SDK.
</Warning>

### Python: ClaudeCodeOptions renamed to ClaudeAgentOptions

**What changed:** The Python SDK type `ClaudeCodeOptions` has been renamed to `ClaudeAgentOptions`.

**Migration:**

```python theme={null}
# BEFORE (claude-code-sdk)
from claude_code_sdk import query, ClaudeCodeOptions

options = ClaudeCodeOptions(model="claude-opus-4-7", permission_mode="acceptEdits")

# AFTER (claude-agent-sdk)
from claude_agent_sdk import query, ClaudeAgentOptions

options = ClaudeAgentOptions(model="claude-opus-4-7", permission_mode="acceptEdits")
```

### System prompt no longer default

**What changed:** The SDK no longer uses Claude Code's system prompt by default.

**Migration:**

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // BEFORE (v0.0.x) - Used Claude Code's system prompt by default
  const before = query({ prompt: "Hello" });

  // AFTER (v0.1.0) - Uses minimal system prompt by default
  // To get the old behavior, explicitly request Claude Code's preset:
  const presetResult = query({
    prompt: "Hello",
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" }
    }
  });

  // Or use a custom system prompt:
  const customResult = query({
    prompt: "Hello",
    options: {
      systemPrompt: "You are a helpful coding assistant"
    }
  });
  ```

  ```python Python theme={null}
  from claude_agent_sdk import query, ClaudeAgentOptions
  import asyncio


  async def main():
      # BEFORE (v0.0.x) - Used Claude Code's system prompt by default
      async for message in query(prompt="Hello"):
          print(message)

      # AFTER (v0.1.0) - Uses minimal system prompt by default
      # To get the old behavior, explicitly request Claude Code's preset:
      async for message in query(
          prompt="Hello",
          options=ClaudeAgentOptions(
              system_prompt={"type": "preset", "preset": "claude_code"}  # Use the preset
          ),
      ):
          print(message)

      # Or use a custom system prompt:
      async for message in query(
          prompt="Hello",
          options=ClaudeAgentOptions(system_prompt="You are a helpful coding assistant"),
      ):
          print(message)


  asyncio.run(main())
  ```
</CodeGroup>

**Why this changed:** Provides better control and isolation for SDK applications. You can now build agents with custom behavior without inheriting Claude Code's CLI-focused instructions.

### Settings sources default

This default was briefly changed in v0.1.0 to load no filesystem settings and then reverted, so no migration action is needed.

**Current behavior:** Omitting `settingSources` on `query()` loads user, project, and local filesystem settings, matching the CLI. This includes `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, CLAUDE.md files, and custom commands.

To run isolated from filesystem settings, pass an empty array:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  const isolatedResult = query({
    prompt: "Hello",
    options: {
      settingSources: [] // No filesystem settings loaded
    }
  });

  // Or load only specific sources:
  const projectOnlyResult = query({
    prompt: "Hello",
    options: {
      settingSources: ["project"] // Only project settings
    }
  });
  ```

  ```python Python theme={null}
  from claude_agent_sdk import query, ClaudeAgentOptions
  import asyncio


  async def main():
      async for message in query(
          prompt="Hello",
          options=ClaudeAgentOptions(setting_sources=[]),  # No filesystem settings loaded
      ):
          print(message)

      # Or load only specific sources:
      async for message in query(
          prompt="Hello",
          options=ClaudeAgentOptions(
              setting_sources=["project"]  # Only project settings
          ),
      ):
          print(message)


  asyncio.run(main())
  ```
</CodeGroup>

Isolation is especially important for CI/CD pipelines, deployed applications, test environments, and multi-tenant systems where local customizations should not leak in.

<Note>
  Python SDK 0.1.59 and earlier treated an empty list the same as omitting the option, so upgrade before relying on `setting_sources=[]`. See [What settingSources does not control](/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control) for inputs that are read even when `settingSources` is `[]`.
</Note>

## Next Steps

* Explore the [Agent SDK Overview](/docs/en/agent-sdk/overview) to learn about available features
* Check out the [TypeScript SDK Reference](/docs/en/agent-sdk/typescript) for detailed API documentation
* Review the [Python SDK Reference](/docs/en/agent-sdk/python) for Python-specific documentation
* Learn about [Custom Tools](/docs/en/agent-sdk/custom-tools) and [MCP Integration](/docs/en/agent-sdk/mcp)
