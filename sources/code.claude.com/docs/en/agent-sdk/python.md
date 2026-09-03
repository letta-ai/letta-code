> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent SDK reference - Python

> Complete API reference for the Python Agent SDK, including all functions, types, and classes.

## Installation

Install the package into a virtual environment. On recent Debian, Ubuntu, and Homebrew Python installs, running `pip install` against system Python fails with `error: externally-managed-environment`.

```bash theme={null}
python3 -m venv .venv
source .venv/bin/activate
pip install claude-agent-sdk
```

For uv, Windows PowerShell, and API key setup, see [Setup in the Agent SDK quickstart](/docs/en/agent-sdk/quickstart#setup).

## Choosing between `query()` and `ClaudeSDKClient`

The Python SDK provides two ways to interact with Claude Code:

| Feature             | `query()`                                      | `ClaudeSDKClient`                  |
| :------------------ | :--------------------------------------------- | :--------------------------------- |
| **Session**         | Creates a new session by default               | Reuses same session                |
| **Conversation**    | Single exchange                                | Multiple exchanges in same context |
| **Connection**      | Managed automatically                          | Manual control                     |
| **Streaming Input** | ✅ Supported                                    | ✅ Supported                        |
| **Interrupts**      | ❌ Not supported                                | ✅ Supported                        |
| **Hooks**           | ✅ Supported                                    | ✅ Supported                        |
| **Custom Tools**    | ✅ Supported                                    | ✅ Supported                        |
| **Continue Chat**   | Manual via `continue_conversation` or `resume` | ✅ Automatic                        |
| **Use Case**        | One-off tasks                                  | Continuous conversations           |

Use `ClaudeSDKClient` for interactive applications such as chat interfaces, or when the next action depends on Claude's response.

## Functions

<Note>Signature blocks and bare `async for` / `async with` fragments on this page are illustrative. To run them, wrap the body in `async def main(): ...` and call `asyncio.run(main())`.</Note>

### `query()`

Creates a new session for each interaction with Claude Code by default. Returns an async iterator that yields messages as they arrive. Each call to `query()` starts fresh with no memory of previous interactions unless you pass `continue_conversation=True` or `resume` in [`ClaudeAgentOptions`](#claudeagentoptions). See [Sessions](/docs/en/agent-sdk/sessions).

```python theme={null}
async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: ClaudeAgentOptions | None = None,
    transport: Transport | None = None
) -> AsyncIterator[Message]
```

#### Parameters

| Parameter   | Type                         | Description                                                                |
| :---------- | :--------------------------- | :------------------------------------------------------------------------- |
| `prompt`    | `str \| AsyncIterable[dict]` | The input prompt as a string or async iterable for streaming mode          |
| `options`   | `ClaudeAgentOptions \| None` | Optional configuration object (defaults to `ClaudeAgentOptions()` if None) |
| `transport` | `Transport \| None`          | Optional custom transport for communicating with the CLI process           |

#### Returns

Returns an `AsyncIterator[Message]` that yields messages from the conversation.

#### Example - With options

```python theme={null}
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    options = ClaudeAgentOptions(
        system_prompt="You are an expert Python developer",
        permission_mode="acceptEdits",
    )

    async for message in query(prompt="Create a Python web server", options=options):
        print(message)


asyncio.run(main())
```

### `tool()`

Decorator for defining MCP tools with type safety.

```python theme={null}
def tool(
    name: str,
    description: str,
    input_schema: type | dict[str, Any],
    annotations: ToolAnnotations | None = None
) -> Callable[[Callable[[Any], Awaitable[dict[str, Any]]]], SdkMcpTool[Any]]
```

#### Parameters

| Parameter      | Type                                            | Description                                                         |
| :------------- | :---------------------------------------------- | :------------------------------------------------------------------ |
| `name`         | `str`                                           | Unique identifier for the tool                                      |
| `description`  | `str`                                           | Human-readable description of what the tool does                    |
| `input_schema` | `type \| dict[str, Any]`                        | Schema defining the tool's input parameters (see below)             |
| `annotations`  | [`ToolAnnotations`](#toolannotations)` \| None` | Optional MCP tool annotations providing behavioral hints to clients |

#### Input schema options

1. **Simple type mapping** (recommended):

   ```python theme={null}
   {"text": str, "count": int, "enabled": bool}
   ```

2. **JSON Schema format** (for complex validation):
   ```python theme={null}
   {
       "type": "object",
       "properties": {
           "text": {"type": "string"},
           "count": {"type": "integer", "minimum": 0},
       },
       "required": ["text"],
   }
   ```

#### Returns

A decorator function that wraps the tool implementation and returns an `SdkMcpTool` instance.

#### Example

```python theme={null}
from claude_agent_sdk import tool
from typing import Any


@tool("greet", "Greet a user", {"name": str})
async def greet(args: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": f"Hello, {args['name']}!"}]}
```

#### `ToolAnnotations`

Behavioral hints for a tool, passed as the `annotations` argument of [`tool()`](#tool). `ToolAnnotations` extends the MCP SDK's `mcp.types.ToolAnnotations` with a `maxResultSizeChars` field, and you can write each hint in camelCase or snake\_case: `ToolAnnotations(readOnlyHint=True)` and `ToolAnnotations(read_only_hint=True)` are equivalent. You can also pass a plain `mcp.types.ToolAnnotations` wherever the SDK accepts annotations.

The snake\_case names and the typed `maxResultSizeChars` field require Python Agent SDK 0.2.140 or later. Versions 0.1.31 through 0.2.139 re-export `mcp.types.ToolAnnotations` unchanged. On versions 0.1.55 through 0.2.139 you can still pass `maxResultSizeChars` as a keyword argument: the MCP class accepts extra fields, and the SDK forwards the value to Claude Code.

All fields are optional. Clients shouldn't rely on the hints for security decisions.

| Field                | Type           | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------- | :------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`              | `str \| None`  | `None`  | Human-readable title for the tool                                                                                                                                                                                                                                                                                                                                                                                 |
| `readOnlyHint`       | `bool \| None` | `False` | If `True`, the tool does not modify its environment                                                                                                                                                                                                                                                                                                                                                               |
| `destructiveHint`    | `bool \| None` | `True`  | If `True`, the tool may perform destructive updates (only meaningful when `readOnlyHint` is `False`)                                                                                                                                                                                                                                                                                                              |
| `idempotentHint`     | `bool \| None` | `False` | If `True`, repeated calls with the same arguments have no additional effect (only meaningful when `readOnlyHint` is `False`)                                                                                                                                                                                                                                                                                      |
| `openWorldHint`      | `bool \| None` | `True`  | If `True`, the tool interacts with external entities (for example, web search). If `False`, the tool's domain is closed (for example, a memory tool)                                                                                                                                                                                                                                                              |
| `maxResultSizeChars` | `int \| None`  | `None`  | Number of characters up to which Claude Code keeps this tool's text result inline in the conversation instead of saving it to a file, up to 500,000. Results that contain images aren't affected. A Claude Code setting rather than an MCP hint: the SDK sends it in the tool's `_meta` as `anthropic/maxResultSizeChars`. See [Raise the limit for a specific tool](/docs/en/mcp#raise-the-limit-for-a-specific-tool) |

```python theme={null}
from claude_agent_sdk import tool, ToolAnnotations
from typing import Any


@tool(
    "search",
    "Search the web",
    {"query": str},
    annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
)
async def search(args: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": f"Results for: {args['query']}"}]}
```

### `create_sdk_mcp_server()`

Create an in-process MCP server that runs within your Python application.

```python theme={null}
def create_sdk_mcp_server(
    name: str,
    version: str = "1.0.0",
    tools: list[SdkMcpTool[Any]] | None = None
) -> McpSdkServerConfig
```

#### Parameters

| Parameter | Type                            | Default   | Description                                           |
| :-------- | :------------------------------ | :-------- | :---------------------------------------------------- |
| `name`    | `str`                           | -         | Unique identifier for the server                      |
| `version` | `str`                           | `"1.0.0"` | Server version string                                 |
| `tools`   | `list[SdkMcpTool[Any]] \| None` | `None`    | List of tool functions created with `@tool` decorator |

#### Returns

Returns an `McpSdkServerConfig` object that can be passed to `ClaudeAgentOptions.mcp_servers`.

#### Example

```python theme={null}
from claude_agent_sdk import tool, create_sdk_mcp_server, ClaudeAgentOptions


@tool("add", "Add two numbers", {"a": float, "b": float})
async def add(args):
    return {"content": [{"type": "text", "text": f"Sum: {args['a'] + args['b']}"}]}


@tool("multiply", "Multiply two numbers", {"a": float, "b": float})
async def multiply(args):
    return {"content": [{"type": "text", "text": f"Product: {args['a'] * args['b']}"}]}


calculator = create_sdk_mcp_server(
    name="calculator",
    version="2.0.0",
    tools=[add, multiply],  # Pass decorated functions
)

# Use with Claude
options = ClaudeAgentOptions(
    mcp_servers={"calc": calculator},
    allowed_tools=["mcp__calc__add", "mcp__calc__multiply"],
)
```

### `list_sessions()`

Lists past sessions with metadata. Filter by project directory or list sessions across all projects. Synchronous; returns immediately.

```python theme={null}
def list_sessions(
    directory: str | None = None,
    limit: int | None = None,
    offset: int = 0,
    include_worktrees: bool = True
) -> list[SDKSessionInfo]
```

#### Parameters

| Parameter           | Type          | Default | Description                                                                                      |
| :------------------ | :------------ | :------ | :----------------------------------------------------------------------------------------------- |
| `directory`         | `str \| None` | `None`  | Directory to list sessions for. When omitted, returns sessions across all projects               |
| `limit`             | `int \| None` | `None`  | Maximum number of sessions to return                                                             |
| `offset`            | `int`         | `0`     | Number of sessions to skip from the start of the sorted results. Use with `limit` for pagination |
| `include_worktrees` | `bool`        | `True`  | When `directory` is inside a git repository, include sessions from all worktree paths            |

#### Return type: `SDKSessionInfo`

| Property        | Type          | Description                                                          |
| :-------------- | :------------ | :------------------------------------------------------------------- |
| `session_id`    | `str`         | Unique session identifier                                            |
| `summary`       | `str`         | Display title: custom title, auto-generated summary, or first prompt |
| `last_modified` | `int`         | Last modified time in milliseconds since epoch                       |
| `file_size`     | `int \| None` | Session file size in bytes (`None` for remote storage backends)      |
| `custom_title`  | `str \| None` | User-set session title                                               |
| `first_prompt`  | `str \| None` | First meaningful user prompt in the session                          |
| `git_branch`    | `str \| None` | Git branch at the end of the session                                 |
| `cwd`           | `str \| None` | Working directory for the session                                    |
| `tag`           | `str \| None` | User-set session tag (see [`tag_session()`](#tag_session))           |
| `created_at`    | `int \| None` | Session creation time in milliseconds since epoch                    |

#### Example

Print the 10 most recent sessions for a project. Results are sorted by `last_modified` descending, so the first item is the newest. Omit `directory` to search across all projects.

```python theme={null}
from claude_agent_sdk import list_sessions

for session in list_sessions(directory="/path/to/project", limit=10):
    print(f"{session.summary} ({session.session_id})")
```

### `get_session_messages()`

Retrieves messages from a past session. Synchronous; returns immediately.

```python theme={null}
def get_session_messages(
    session_id: str,
    directory: str | None = None,
    limit: int | None = None,
    offset: int = 0
) -> list[SessionMessage]
```

#### Parameters

| Parameter    | Type          | Default  | Description                                                       |
| :----------- | :------------ | :------- | :---------------------------------------------------------------- |
| `session_id` | `str`         | required | The session ID to retrieve messages for                           |
| `directory`  | `str \| None` | `None`   | Project directory to look in. When omitted, searches all projects |
| `limit`      | `int \| None` | `None`   | Maximum number of messages to return                              |
| `offset`     | `int`         | `0`      | Number of messages to skip from the start                         |

#### Return type: `SessionMessage`

| Property             | Type                           | Description                                                                                                                                                                                                                                                       |
| :------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `Literal["user", "assistant"]` | Message role                                                                                                                                                                                                                                                      |
| `uuid`               | `str`                          | Unique message identifier                                                                                                                                                                                                                                         |
| `session_id`         | `str`                          | Session identifier                                                                                                                                                                                                                                                |
| `message`            | `Any`                          | Raw message content                                                                                                                                                                                                                                               |
| `parent_tool_use_id` | `str \| None`                  | For subagent messages, the id of the spawning `Agent` tool-use block. `None` for main-session messages and older sessions                                                                                                                                         |
| `parent_agent_id`    | `str \| None`                  | For messages from a [nested subagent](/docs/en/sub-agents#let-subagents-spawn-their-own-subagents), the agent id of the parent subagent. `None` for main-session messages, top-level subagent messages, and older sessions. Requires Python Agent SDK 0.2.140 or later |

#### Example

```python theme={null}
from claude_agent_sdk import list_sessions, get_session_messages

sessions = list_sessions(limit=1)
if sessions:
    messages = get_session_messages(sessions[0].session_id)
    for msg in messages:
        print(f"[{msg.type}] {msg.uuid}")
```

### `get_session_info()`

Reads metadata for a single session by ID without scanning the full project directory. Synchronous; returns immediately.

```python theme={null}
def get_session_info(
    session_id: str,
    directory: str | None = None,
) -> SDKSessionInfo | None
```

#### Parameters

| Parameter    | Type          | Default  | Description                                                            |
| :----------- | :------------ | :------- | :--------------------------------------------------------------------- |
| `session_id` | `str`         | required | UUID of the session to look up                                         |
| `directory`  | `str \| None` | `None`   | Project directory path. When omitted, searches all project directories |

Returns [`SDKSessionInfo`](#return-type-sdksessioninfo), or `None` if the session is not found.

#### Example

Look up a single session's metadata without scanning the project directory. Useful when you already have a session ID from a previous run.

```python theme={null}
from claude_agent_sdk import get_session_info

info = get_session_info("550e8400-e29b-41d4-a716-446655440000")
if info:
    print(f"{info.summary} (branch: {info.git_branch}, tag: {info.tag})")
```

### `rename_session()`

Renames a session by appending a custom-title entry. Repeated calls are safe; the most recent title wins. Synchronous.

```python theme={null}
def rename_session(
    session_id: str,
    title: str,
    directory: str | None = None,
) -> None
```

#### Parameters

| Parameter    | Type          | Default  | Description                                                            |
| :----------- | :------------ | :------- | :--------------------------------------------------------------------- |
| `session_id` | `str`         | required | UUID of the session to rename                                          |
| `title`      | `str`         | required | New title. Must be non-empty after stripping whitespace                |
| `directory`  | `str \| None` | `None`   | Project directory path. When omitted, searches all project directories |

Raises `ValueError` if `session_id` is not a valid UUID or `title` is empty; `FileNotFoundError` if the session cannot be found.

#### Example

Rename the most recent session so it's easier to find later. The new title appears in [`SDKSessionInfo.custom_title`](#return-type-sdksessioninfo) on subsequent reads.

```python theme={null}
from claude_agent_sdk import list_sessions, rename_session

sessions = list_sessions(directory="/path/to/project", limit=1)
if sessions:
    rename_session(sessions[0].session_id, "Refactor auth module")
```

### `tag_session()`

Tags a session. Pass `None` to clear the tag. Repeated calls are safe; the most recent tag wins. Synchronous.

```python theme={null}
def tag_session(
    session_id: str,
    tag: str | None,
    directory: str | None = None,
) -> None
```

#### Parameters

| Parameter    | Type          | Default  | Description                                                            |
| :----------- | :------------ | :------- | :--------------------------------------------------------------------- |
| `session_id` | `str`         | required | UUID of the session to tag                                             |
| `tag`        | `str \| None` | required | Tag string, or `None` to clear. Unicode-sanitized before storing       |
| `directory`  | `str \| None` | `None`   | Project directory path. When omitted, searches all project directories |

Raises `ValueError` if `session_id` is not a valid UUID or `tag` is empty after sanitization; `FileNotFoundError` if the session cannot be found.

#### Example

Tag a session, then filter by that tag on a later read. Pass `None` to clear an existing tag.

```python theme={null}
from claude_agent_sdk import list_sessions, tag_session

# Tag the most recent session
sessions = list_sessions(directory="/path/to/project", limit=1)
if sessions:
    tag_session(sessions[0].session_id, "needs-review")

# Later: find all sessions with that tag
for session in list_sessions(directory="/path/to/project"):
    if session.tag == "needs-review":
        print(session.summary)
```

## Classes

### `ClaudeSDKClient`

**Maintains a conversation session across multiple exchanges.** This is the Python equivalent of how the TypeScript SDK's `query()` function works internally - it creates a client object that can continue conversations. See the [comparison with `query()`](#choosing-between-query-and-claudesdkclient).

```python theme={null}
class ClaudeSDKClient:
    def __init__(self, options: ClaudeAgentOptions | None = None, transport: Transport | None = None)
    async def connect(self, prompt: str | AsyncIterable[dict] | None = None) -> None
    async def query(self, prompt: str | AsyncIterable[dict], session_id: str = "default") -> None
    async def receive_messages(self) -> AsyncIterator[Message]
    async def receive_response(self) -> AsyncIterator[Message]
    async def interrupt(self) -> None
    async def set_permission_mode(self, mode: str) -> None
    async def set_model(self, model: str | None = None) -> None
    async def rewind_files(self, user_message_id: str) -> None
    async def get_mcp_status(self) -> McpStatusResponse
    async def reconnect_mcp_server(self, server_name: str) -> None
    async def toggle_mcp_server(self, server_name: str, enabled: bool) -> None
    async def stop_task(self, task_id: str) -> None
    async def get_server_info(self) -> dict[str, Any] | None
    async def disconnect(self) -> None
```

#### Methods

| Method                                    | Description                                                                                                                                                       |
| :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__init__(options)`                       | Initialize the client with optional configuration                                                                                                                 |
| `connect(prompt)`                         | Connect to Claude with an optional initial prompt or message stream                                                                                               |
| `query(prompt, session_id)`               | Send a new request in streaming mode                                                                                                                              |
| `receive_messages()`                      | Receive all messages from Claude as an async iterator                                                                                                             |
| `receive_response()`                      | Receive messages until and including a ResultMessage                                                                                                              |
| `interrupt()`                             | Send interrupt signal (only works in streaming mode)                                                                                                              |
| `set_permission_mode(mode)`               | Change the permission mode for the current session                                                                                                                |
| `set_model(model)`                        | Change the model for the current session. Pass `None` to reset to default                                                                                         |
| `rewind_files(user_message_id)`           | Restore files to their state at the specified user message. Requires `enable_file_checkpointing=True`. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing) |
| `get_mcp_status()`                        | Get the status of all configured MCP servers. Returns [`McpStatusResponse`](#mcpstatusresponse)                                                                   |
| `reconnect_mcp_server(server_name)`       | Retry connecting to an MCP server that failed or was disconnected                                                                                                 |
| `toggle_mcp_server(server_name, enabled)` | Enable or disable an MCP server mid-session. Disabling removes its tools                                                                                          |
| `stop_task(task_id)`                      | Stop a running background task. A [`TaskNotificationMessage`](#tasknotificationmessage) with status `"stopped"` follows in the message stream                     |
| `get_server_info()`                       | Get server information including session ID and capabilities                                                                                                      |
| `disconnect()`                            | Disconnect from Claude                                                                                                                                            |

#### Context Manager Support

The client can be used as an async context manager for automatic connection management:

```python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient


async def main():
    async with ClaudeSDKClient() as client:
        await client.query("Hello Claude")
        async for message in client.receive_response():
            print(message)


asyncio.run(main())
```

> **Important:** When iterating over messages, avoid using `break` to exit early as this can cause asyncio cleanup issues. Instead, let the iteration complete naturally or use flags to track when you've found what you need.

#### Example - Continuing a conversation

```python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient, AssistantMessage, TextBlock, ResultMessage


async def main():
    async with ClaudeSDKClient() as client:
        # First question
        await client.query("What's the capital of France?")

        # Process response
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(f"Claude: {block.text}")

        # Follow-up question - the session retains the previous context
        await client.query("What's the population of that city?")

        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(f"Claude: {block.text}")

        # Another follow-up - still in the same conversation
        await client.query("What are some famous landmarks there?")

        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(f"Claude: {block.text}")


asyncio.run(main())
```

#### Example - Streaming input with ClaudeSDKClient

```python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient


async def message_stream():
    """Generate messages dynamically."""
    yield {
        "type": "user",
        "message": {"role": "user", "content": "Analyze the following data:"},
    }
    await asyncio.sleep(0.5)
    yield {
        "type": "user",
        "message": {"role": "user", "content": "Temperature: 25°C, Humidity: 60%"},
    }
    await asyncio.sleep(0.5)
    yield {
        "type": "user",
        "message": {"role": "user", "content": "What patterns do you see?"},
    }


async def main():
    async with ClaudeSDKClient() as client:
        # Stream input to Claude
        await client.query(message_stream())

        # Process response
        async for message in client.receive_response():
            print(message)

        # Follow-up in same session
        await client.query("Should we be concerned about these readings?")

        async for message in client.receive_response():
            print(message)


asyncio.run(main())
```

#### Example - Using interrupts

```python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, ResultMessage


async def interruptible_task():
    options = ClaudeAgentOptions(allowed_tools=["Bash"], permission_mode="acceptEdits")

    async with ClaudeSDKClient(options=options) as client:
        # Start a long-running task
        await client.query("Count from 1 to 100 slowly, using the bash sleep command")

        # Let it run for a bit
        await asyncio.sleep(2)

        # Interrupt the task
        await client.interrupt()
        print("Task interrupted!")

        # Drain the interrupted task's messages (including its ResultMessage)
        async for message in client.receive_response():
            if isinstance(message, ResultMessage):
                print(f"Interrupted task: terminal_reason={message.terminal_reason!r}")
                # terminal_reason is "aborted_streaming" or "aborted_tools"
                # for interrupted turns

        # Send a new command
        await client.query("Just say hello instead")

        # Now receive the new response
        async for message in client.receive_response():
            if isinstance(message, ResultMessage) and message.subtype == "success":
                print(f"New result: {message.result}")


asyncio.run(interruptible_task())
```

<Note>
  **Buffer behavior after interrupt:** `interrupt()` sends a stop signal but does not clear the message buffer. Messages already produced by the interrupted task, including its `ResultMessage`, remain in the stream. You must drain them with `receive_response()` before reading the response to a new query. If you send a new query immediately after `interrupt()` and call `receive_response()` only once, you'll receive the interrupted task's messages, not the new query's response.
</Note>

#### Example - Advanced permission control

```python theme={null}
import asyncio
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from claude_agent_sdk.types import (
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
)


async def custom_permission_handler(
    tool_name: str, input_data: dict, context: ToolPermissionContext
) -> PermissionResultAllow | PermissionResultDeny:
    """Custom logic for tool permissions."""

    # Block writes to system directories
    if tool_name == "Write" and input_data.get("file_path", "").startswith("/system/"):
        return PermissionResultDeny(
            message="System directory write not allowed", interrupt=True
        )

    # Redirect sensitive file operations
    if tool_name in ["Write", "Edit"] and "config" in input_data.get("file_path", ""):
        safe_path = f"./sandbox/{input_data['file_path']}"
        return PermissionResultAllow(
            updated_input={**input_data, "file_path": safe_path}
        )

    # Allow everything else
    return PermissionResultAllow(updated_input=input_data)


async def main():
    # Don't also list the gated tools in allowed_tools: allow rules approve calls before can_use_tool runs
    options = ClaudeAgentOptions(can_use_tool=custom_permission_handler)

    async with ClaudeSDKClient(options=options) as client:
        await client.query("Update the system config file")

        async for message in client.receive_response():
            # Will use sandbox path instead
            print(message)


asyncio.run(main())
```

## Types

<Note>
  **`@dataclass` vs `TypedDict`:** This SDK uses two kinds of types. Classes decorated with `@dataclass` (such as `ResultMessage`, `AgentDefinition`, `TextBlock`) are object instances at runtime and support attribute access: `msg.result`. Classes defined with `TypedDict` (such as `ThinkingConfigEnabled`, `McpStdioServerConfig`, `SyncHookJSONOutput`) are **plain dicts at runtime** and require key access: `config["budget_tokens"]`, not `config.budget_tokens`. The `ClassName(field=value)` call syntax works for both, but only dataclasses produce objects with attributes.
</Note>

### `SdkMcpTool`

Definition for an SDK MCP tool created with the `@tool` decorator.

```python theme={null}
@dataclass
class SdkMcpTool(Generic[T]):
    name: str
    description: str
    input_schema: type[T] | dict[str, Any]
    handler: Callable[[T], Awaitable[dict[str, Any]]]
    annotations: ToolAnnotations | None = None
```

| Property       | Type                                            | Description                                                                                                      |
| :------------- | :---------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `name`         | `str`                                           | Unique identifier for the tool                                                                                   |
| `description`  | `str`                                           | Human-readable description                                                                                       |
| `input_schema` | `type[T] \| dict[str, Any]`                     | Schema for input validation                                                                                      |
| `handler`      | `Callable[[T], Awaitable[dict[str, Any]]]`      | Async function that handles tool execution                                                                       |
| `annotations`  | [`ToolAnnotations`](#toolannotations)` \| None` | Optional tool annotations (for example `readOnlyHint`, `destructiveHint`, `openWorldHint`, `maxResultSizeChars`) |

### `Transport`

Abstract base class for custom transport implementations. Use this to communicate with the Claude process over a custom channel (for example, a remote connection instead of a local subprocess).

<Warning>
  This is a low-level internal API. The interface may change in future releases. Custom implementations must be updated to match any interface changes.
</Warning>

```python theme={null}
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any


class Transport(ABC):
    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def write(self, data: str) -> None: ...

    @abstractmethod
    def read_messages(self) -> AsyncIterator[dict[str, Any]]: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    def is_ready(self) -> bool: ...

    @abstractmethod
    async def end_input(self) -> None: ...
```

| Method            | Description                                                                 |
| :---------------- | :-------------------------------------------------------------------------- |
| `connect()`       | Connect the transport and prepare for communication                         |
| `write(data)`     | Write raw data (JSON + newline) to the transport                            |
| `read_messages()` | Async iterator that yields parsed JSON messages                             |
| `close()`         | Close the connection and clean up resources                                 |
| `is_ready()`      | Returns `True` if the transport can send and receive                        |
| `end_input()`     | Close the input stream (for example, close stdin for subprocess transports) |

Import: `from claude_agent_sdk import Transport`

### `ClaudeAgentOptions`

Configuration dataclass for Claude Code queries.

```python theme={null}
@dataclass
class ClaudeAgentOptions:
    tools: list[str] | ToolsPreset | None = None
    allowed_tools: list[str] = field(default_factory=list)
    system_prompt: str | SystemPromptPreset | SystemPromptFile | None = None
    mcp_servers: dict[str, McpServerConfig] | str | Path = field(default_factory=dict)
    strict_mcp_config: bool = False
    permission_mode: PermissionMode | None = None
    continue_conversation: bool = False
    resume: str | None = None
    session_id: str | None = None
    max_turns: int | None = None
    max_budget_usd: float | None = None
    disallowed_tools: list[str] = field(default_factory=list)
    model: str | None = None
    fallback_model: str | None = None
    betas: list[SdkBeta] = field(default_factory=list)
    output_format: dict[str, Any] | None = None
    permission_prompt_tool_name: str | None = None
    cwd: str | Path | None = None
    cli_path: str | Path | None = None
    settings: str | None = None
    add_dirs: list[str | Path] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    extra_args: dict[str, str | None] = field(default_factory=dict)
    max_buffer_size: int | None = None
    debug_stderr: Any = sys.stderr  # Deprecated
    stderr: Callable[[str], None] | None = None
    can_use_tool: CanUseTool | None = None
    hooks: dict[HookEvent, list[HookMatcher]] | None = None
    user: str | None = None
    include_partial_messages: bool = False
    include_hook_events: bool = False
    forward_subagent_text: bool = False
    fork_session: bool = False
    resume_session_at: str | None = None
    resume_drops_turn: str | None = None
    agents: dict[str, AgentDefinition] | None = None
    setting_sources: list[SettingSource] | None = None
    skills: list[str] | Literal["all"] | None = None
    sandbox: SandboxSettings | None = None
    plugins: list[SdkPluginConfig] = field(default_factory=list)
    max_thinking_tokens: int | None = None  # Deprecated: use thinking instead
    thinking: ThinkingConfig | None = None
    effort: EffortLevel | None = None
    enable_file_checkpointing: bool = False
    session_store: SessionStore | None = None
    session_store_flush: SessionStoreFlushMode = "batched"
    load_timeout_ms: int = 60_000
    task_budget: TaskBudget | None = None
```

| Property                      | Type                                                                                  | Default                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :---------------------------- | :------------------------------------------------------------------------------------ | :--------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`                       | `list[str] \| ToolsPreset \| None`                                                    | `None`                             | Tools configuration. Use `{"type": "preset", "preset": "claude_code"}` for Claude Code's default tools                                                                                                                                                                                                                                                                                                                                                                      |
| `allowed_tools`               | `list[str]`                                                                           | `[]`                               | Tools to auto-approve without prompting. This does not restrict Claude to only these tools. If you name one of the [task-tracking tools](/docs/en/agent-sdk/todo-tracking#model-availability) here, Claude Code also opts the session in. Other unlisted tools fall through to `permission_mode` and `can_use_tool`. Use `disallowed_tools` to block tools. See [Permissions](/docs/en/agent-sdk/permissions#allow-and-deny-rules)                                                    |
| `system_prompt`               | `str \| SystemPromptPreset \| SystemPromptFile \| None`                               | `None`                             | System prompt configuration. Pass a string for a custom prompt, `{"type": "preset", "preset": "claude_code"}` for Claude Code's system prompt with optional `"append"`, or `{"type": "file", "path": "..."}` to load a large prompt from disk. See [`SystemPromptPreset`](#systempromptpreset) and [`SystemPromptFile`](#systempromptfile)                                                                                                                                  |
| `mcp_servers`                 | `dict[str, McpServerConfig] \| str \| Path`                                           | `{}`                               | MCP server configurations or path to config file                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `strict_mcp_config`           | `bool`                                                                                | `False`                            | When `True`, use only the servers passed in `mcp_servers` and ignore project `.mcp.json`, user settings, plugin-provided MCP servers, and [claude.ai connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai). Maps to the CLI `--strict-mcp-config` flag                                                                                                                                                                                                                        |
| `permission_mode`             | `PermissionMode \| None`                                                              | `None`                             | Permission mode for tool usage                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `continue_conversation`       | `bool`                                                                                | `False`                            | Continue the most recent conversation                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `resume`                      | `str \| None`                                                                         | `None`                             | Session ID to resume                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session_id`                  | `str \| None`                                                                         | `None`                             | Use a specific session ID instead of an auto-generated one. Must be a valid UUID. Can't be combined with `continue_conversation` or `resume` unless `fork_session` is also set                                                                                                                                                                                                                                                                                              |
| `max_turns`                   | `int \| None`                                                                         | `None`                             | Maximum agentic turns (tool-use round trips)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `max_budget_usd`              | `float \| None`                                                                       | `None`                             | Stop the query when the client-side cost estimate reaches this USD value. Compared against the same estimate as `total_cost_usd`; see [Track cost and usage](/docs/en/agent-sdk/cost-tracking) for accuracy caveats                                                                                                                                                                                                                                                              |
| `disallowed_tools`            | `list[str]`                                                                           | `[]`                               | Tools to deny. A bare name such as `"Bash"` removes the tool from Claude's context. A scoped rule such as `"Bash(rm *)"` leaves the tool available and denies matching calls in every permission mode, including `bypassPermissions`. See [Permissions](/docs/en/agent-sdk/permissions#allow-and-deny-rules)                                                                                                                                                                     |
| `enable_file_checkpointing`   | `bool`                                                                                | `False`                            | Enable file change tracking for rewinding. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing)                                                                                                                                                                                                                                                                                                                                                                       |
| `model`                       | `str \| None`                                                                         | `None`                             | Claude model alias or full model name. See [accepted values and provider-specific IDs](/docs/en/model-config#available-models)                                                                                                                                                                                                                                                                                                                                                   |
| `fallback_model`              | `str \| None`                                                                         | `None`                             | Fallback model to use if the primary model fails                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `betas`                       | `list[SdkBeta]`                                                                       | `[]`                               | Beta features to enable. See [`SdkBeta`](#sdkbeta) for available options                                                                                                                                                                                                                                                                                                                                                                                                    |
| `output_format`               | `dict[str, Any] \| None`                                                              | `None`                             | Output format for structured responses (e.g., `{"type": "json_schema", "schema": {...}}`). See [Structured outputs](/docs/en/agent-sdk/structured-outputs) for details                                                                                                                                                                                                                                                                                                           |
| `permission_prompt_tool_name` | `str \| None`                                                                         | `None`                             | MCP tool name for permission prompts                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cwd`                         | `str \| Path \| None`                                                                 | `None`                             | Current working directory                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cli_path`                    | `str \| Path \| None`                                                                 | `None`                             | Custom path to the Claude Code CLI executable                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `settings`                    | `str \| None`                                                                         | `None`                             | Path to settings file                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `add_dirs`                    | `list[str \| Path]`                                                                   | `[]`                               | Additional directories Claude can access. The SDK passes each entry to Claude Code as `--add-dir`, so with the `project` setting source Claude Code also [loads the directory's skills, commands, and subagents](/docs/en/permissions#additional-directories-grant-file-access-not-configuration)                                                                                                                                                                                |
| `env`                         | `dict[str, str]`                                                                      | `{}`                               | Environment variables merged on top of the inherited process environment. See [Environment variables](/docs/en/env-vars) for variables the underlying CLI reads, and [Handle slow or stalled API responses](#handle-slow-or-stalled-api-responses) for timeout-related variables                                                                                                                                                                                                 |
| `extra_args`                  | `dict[str, str \| None]`                                                              | `{}`                               | Additional CLI arguments to pass directly to the CLI                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `max_buffer_size`             | `int \| None`                                                                         | `None`                             | Maximum bytes when buffering CLI stdout                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `debug_stderr`                | `Any`                                                                                 | `sys.stderr`                       | *Deprecated* - File-like object for debug output. Use `stderr` callback instead                                                                                                                                                                                                                                                                                                                                                                                             |
| `stderr`                      | `Callable[[str], None] \| None`                                                       | `None`                             | Callback function for stderr output from CLI                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `can_use_tool`                | [`CanUseTool`](#canusetool) ` \| None`                                                | `None`                             | Tool permission callback, invoked only when the [permission flow](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) falls through to a prompt. Not invoked for calls auto-approved by `allowed_tools`, allow rules, or `permission_mode`. An allow rule doesn't pre-approve the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves). See [`CanUseTool`](#canusetool) for details                                                     |
| `hooks`                       | `dict[HookEvent, list[HookMatcher]] \| None`                                          | `None`                             | Hook configurations for intercepting events                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `user`                        | `str \| None`                                                                         | `None`                             | User identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `include_partial_messages`    | `bool`                                                                                | `False`                            | Include partial message streaming events. When enabled, [`StreamEvent`](#streamevent) messages are yielded                                                                                                                                                                                                                                                                                                                                                                  |
| `include_hook_events`         | `bool`                                                                                | `False`                            | Include hook lifecycle events in the message stream as `HookEventMessage` objects                                                                                                                                                                                                                                                                                                                                                                                           |
| `forward_subagent_text`       | `bool`                                                                                | `False`                            | Forward subagent text and thinking blocks in the message stream. By default only subagent `tool_use` and `tool_result` blocks are emitted. Requires Python Agent SDK 0.2.140 or later                                                                                                                                                                                                                                                                                       |
| `fork_session`                | `bool`                                                                                | `False`                            | When resuming with `resume`, fork to a new session ID instead of continuing the original session                                                                                                                                                                                                                                                                                                                                                                            |
| `resume_session_at`           | `str \| None`                                                                         | `None`                             | When resuming, load the conversation only up to and including the message with this UUID. Use with `resume`, and usually `fork_session`, to branch from an earlier point. Requires Python Agent SDK 0.2.137 or later                                                                                                                                                                                                                                                        |
| `resume_drops_turn`           | `str \| None`                                                                         | `None`                             | UUID of the user prompt whose turn a `resume_session_at` truncation discards. When set, the CLI refuses the resume if the discarded range holds entries not attributable to that turn. Requires Python Agent SDK 0.2.137 or later and Claude Code v2.1.223 or later; the CLI bundled with those SDK versions satisfies the Claude Code requirement                                                                                                                          |
| `agents`                      | `dict[str, AgentDefinition] \| None`                                                  | `None`                             | Programmatically defined subagents                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plugins`                     | `list[SdkPluginConfig]`                                                               | `[]`                               | Load custom plugins from local paths. See [Plugins](/docs/en/agent-sdk/plugins) for details                                                                                                                                                                                                                                                                                                                                                                                      |
| `sandbox`                     | [`SandboxSettings`](#sandboxsettings) ` \| None`                                      | `None`                             | Configure sandbox behavior programmatically. See [Sandbox settings](#sandboxsettings) for details                                                                                                                                                                                                                                                                                                                                                                           |
| `setting_sources`             | `list[SettingSource] \| None`                                                         | `None` (CLI defaults: all sources) | Control which filesystem settings to load. Pass `[]` to disable user, project, and local settings. Endpoint-managed policy loads regardless; server-managed settings are fetched when the session authenticates with an organization credential on an [eligible configuration](/docs/en/server-managed-settings#platform-availability). See [Use Claude Code features](/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control)                                  |
| `skills`                      | `list[str] \| Literal["all"] \| None`                                                 | `None`                             | Skills available to the session. Pass `"all"` to enable every discovered skill, or a list of skill names. Pass exact names only. The SDK rejects malformed and wildcard-form names with a `ValueError` before starting the Claude Code process; this check requires Python Agent SDK 0.2.129 or later. When set, the SDK adds the Skill tool to `allowed_tools` automatically. If you also pass `tools`, include `"Skill"` in that list. See [Skills](/docs/en/agent-sdk/skills) |
| `max_thinking_tokens`         | `int \| None`                                                                         | `None`                             | *Deprecated* - Maximum tokens for thinking blocks. Use `thinking` instead                                                                                                                                                                                                                                                                                                                                                                                                   |
| `thinking`                    | [`ThinkingConfig`](#thinkingconfig) ` \| None`                                        | `None`                             | Controls extended thinking behavior. Takes precedence over `max_thinking_tokens`                                                                                                                                                                                                                                                                                                                                                                                            |
| `effort`                      | [`EffortLevel`](#effortlevel) ` \| None`                                              | `None`                             | Effort level for thinking depth. See [adjust the effort level](/docs/en/model-config#adjust-effort-level)                                                                                                                                                                                                                                                                                                                                                                        |
| `session_store`               | [`SessionStore`](/docs/en/agent-sdk/session-storage#the-sessionstore-interface) ` \| None` | `None`                             | Mirror session transcripts to an external backend so another host can resume them. See [Persist sessions to external storage](/docs/en/agent-sdk/session-storage)                                                                                                                                                                                                                                                                                                                |
| `session_store_flush`         | `Literal["batched", "eager"]`                                                         | `"batched"`                        | When to flush mirrored transcript entries to `session_store`. `"batched"` flushes once per turn or when the buffer fills; `"eager"` triggers a background flush after every frame. Ignored when `session_store` is `None`                                                                                                                                                                                                                                                   |
| `load_timeout_ms`             | `int`                                                                                 | `60000`                            | Per-call timeout for `session_store.load()` and `list_subkeys()` during resume materialization, in milliseconds                                                                                                                                                                                                                                                                                                                                                             |
| `task_budget`                 | `TaskBudget \| None`                                                                  | `None`                             | API-side token budget. Sent as `output_config.task_budget` with the `task-budgets-2026-03-13` beta header. Pass `{"total": <int>}`.                                                                                                                                                                                                                                                                                                                                         |

#### Handle slow or stalled API responses

The CLI subprocess reads several environment variables that control API timeouts and stall detection. Pass them through `ClaudeAgentOptions.env`:

```python theme={null}
from claude_agent_sdk import ClaudeAgentOptions

options = ClaudeAgentOptions(
    env={
        "API_TIMEOUT_MS": "120000",
        "CLAUDE_CODE_MAX_RETRIES": "2",
        "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS": "120000",
    },
)
```

* `API_TIMEOUT_MS`: per-request timeout on the Anthropic client, in milliseconds. Default `600000`. Applies to the main loop and all subagents.
* `CLAUDE_CODE_MAX_RETRIES`: maximum API retries. Default `10`, capped at `15`. Each retry gets its own `API_TIMEOUT_MS` window, so worst-case wall time is roughly `API_TIMEOUT_MS × (CLAUDE_CODE_MAX_RETRIES + 1)` plus backoff. For unattended runs that need to wait through longer outages, set [`CLAUDE_CODE_RETRY_WATCHDOG=1`](/docs/en/errors#tune-retry-behavior): it retries transient capacity errors indefinitely and, on Claude Code v2.1.199 or later, raises the default for other transient errors to `300` and removes the cap on this variable.
* `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`: stall watchdog for subagents. While the stream watchdog is on, the default is `CLAUDE_STREAM_IDLE_TIMEOUT_MS` plus 5 minutes, which comes to `600000` unless you raise that variable. With the stream watchdog off, the default is `600000`. Before v2.1.257, the default was always `600000`.

  The timer resets on each stream event. On a stall, Claude Code aborts the subagent and reports the stall to the parent. For a background subagent, it also marks the task failed and attaches any partial result.
* `CLAUDE_ENABLE_STREAM_WATCHDOG` with `CLAUDE_STREAM_IDLE_TIMEOUT_MS`: stream watchdog that aborts the request when headers have arrived but the response body stops streaming. The watchdog is on by default for all providers; set `CLAUDE_ENABLE_STREAM_WATCHDOG=0` to disable it. `CLAUDE_STREAM_IDLE_TIMEOUT_MS` defaults to `300000` and is clamped to that minimum. After the abort, [Automatic retries](/docs/en/errors#automatic-retries) covers what Claude Code does, based on how far the response had progressed.

  While the watchdog waits out a response that a gateway behind `ANTHROPIC_BASE_URL` holds open with keep-alive pings, a host that sets `include_partial_messages` keeps receiving `ping` [`StreamEvent`](#streamevent) messages. Read those frames as liveness rather than timing the session out on silence. Before v2.1.257, the frames stopped 5 minutes after the last real stream event.

### `OutputFormat`

Configuration for structured output validation. Pass this as a `dict` to the `output_format` field on `ClaudeAgentOptions`:

```python theme={null}
# Expected dict shape for output_format
{
    "type": "json_schema",
    "schema": {...},  # Your JSON Schema definition
}
```

| Field    | Required | Description                                        |
| :------- | :------- | :------------------------------------------------- |
| `type`   | Yes      | Must be `"json_schema"` for JSON Schema validation |
| `schema` | Yes      | JSON Schema definition for output validation       |

### `SystemPromptPreset`

Configuration for using Claude Code's preset system prompt with optional additions.

```python theme={null}
class SystemPromptPreset(TypedDict):
    type: Literal["preset"]
    preset: Literal["claude_code"]
    append: NotRequired[str]
    exclude_dynamic_sections: NotRequired[bool]
```

| Field                      | Required | Description                                                                                                                                                                                                                                                                                                                  |
| :------------------------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                     | Yes      | Must be `"preset"` to use a preset system prompt                                                                                                                                                                                                                                                                             |
| `preset`                   | Yes      | Must be `"claude_code"` to use Claude Code's system prompt                                                                                                                                                                                                                                                                   |
| `append`                   | No       | Additional instructions to append to the preset system prompt                                                                                                                                                                                                                                                                |
| `exclude_dynamic_sections` | No       | Move per-session context such as working directory, the git-repo flag, and auto memory paths from the system prompt into the first user message. Improves prompt-cache reuse across users and machines. See [Modify system prompts](/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines) |

### `SystemPromptFile`

Configuration for loading a custom system prompt from a file instead of passing it as a string. The SDK maps this to the CLI [`--system-prompt-file`](/docs/en/cli-reference#system-prompt-flags) flag. Use the file form when the prompt is large: the SDK passes a string `system_prompt` on the CLI subprocess argv, which is subject to OS command-line length limits before the SDK sends any API request. On Linux a single argument longer than roughly 128 KB fails at process spawn with `Argument list too long`. On Windows the whole command line is capped at roughly 32 KB, so the string form fails at a lower threshold.

```python theme={null}
class SystemPromptFile(TypedDict):
    type: Literal["file"]
    path: str
```

| Field  | Required | Description                                   |
| :----- | :------- | :-------------------------------------------- |
| `type` | Yes      | Must be `"file"` to load the prompt from disk |
| `path` | Yes      | Path to a file containing the system prompt   |

### `SettingSource`

Controls which filesystem-based configuration sources the SDK loads settings from.

```python theme={null}
SettingSource = Literal["user", "project", "local"]
```

| Value       | Description                                                               | Location                      |
| :---------- | :------------------------------------------------------------------------ | :---------------------------- |
| `"user"`    | Global user settings                                                      | `~/.claude/settings.json`     |
| `"project"` | Shared project settings (version controlled)                              | `.claude/settings.json`       |
| `"local"`   | Local project settings, gitignored when Claude Code saves a setting to it | `.claude/settings.local.json` |

#### Default behavior

When `setting_sources` is omitted or `None`, `query()` loads the same filesystem settings as the Claude Code CLI: user, project, and local. Endpoint-managed policy is loaded in all cases; server-managed settings are fetched when the session authenticates with an organization credential on an [eligible configuration](/docs/en/server-managed-settings#platform-availability). See [What settingSources does not control](/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control) for inputs that are read regardless of this option, and how to disable them.

#### Why use setting\_sources

**Disable filesystem settings:**

```python theme={null}
# Do not load user, project, or local settings from disk
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    async for message in query(
        prompt="Analyze this code",
        options=ClaudeAgentOptions(
            setting_sources=[]
        ),
    ):
        print(message)


asyncio.run(main())
```

<Note>
  In Python SDK 0.1.59 and earlier, an empty list was treated the same as omitting the option, so `setting_sources=[]` did not disable filesystem settings. Upgrade to a newer release if you need an empty list to take effect. The TypeScript SDK is not affected.
</Note>

**Load only specific setting sources:**

```python theme={null}
# Load only project settings, ignore user and local
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    async for message in query(
        prompt="Run CI checks",
        options=ClaudeAgentOptions(
            setting_sources=["project"]  # Only .claude/settings.json
        ),
    ):
        print(message)


asyncio.run(main())
```

**SDK-only applications:**

```python theme={null}
# Define everything programmatically.
# Pass [] to opt out of filesystem setting sources.
import asyncio
from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions, query


async def main():
    async for message in query(
        prompt="Review this PR",
        options=ClaudeAgentOptions(
            setting_sources=[],
            agents={
                "code-reviewer": AgentDefinition(
                    description="Reviews code changes",
                    prompt="You are a code reviewer. Report issues in the diff.",
                ),
            },
            allowed_tools=["Read", "Grep", "Glob"],
        ),
    ):
        print(message)


asyncio.run(main())
```

To load CLAUDE.md project instructions, include `"project"` in `setting_sources`. See [Modify system prompts](/docs/en/agent-sdk/modifying-system-prompts#claude-md-files-for-project-level-instructions) for how CLAUDE.md loading interacts with the system prompt options.

#### Settings precedence

When multiple sources are loaded, settings are merged with this precedence (highest to lowest):

1. Local settings (`.claude/settings.local.json`)
2. Project settings (`.claude/settings.json`)
3. User settings (`~/.claude/settings.json`)

Programmatic options such as `agents` and `allowed_tools` override user, project, and local filesystem settings. Managed policy settings take precedence over programmatic options.

### `AgentDefinition`

Configuration for a subagent defined programmatically.

```python theme={null}
@dataclass
class AgentDefinition:
    description: str
    prompt: str
    tools: list[str] | None = None
    disallowedTools: list[str] | None = None
    model: str | None = None
    skills: list[str] | None = None
    memory: Literal["user", "project", "local"] | None = None
    mcpServers: list[str | dict[str, Any]] | None = None
    initialPrompt: str | None = None
    maxTurns: int | None = None
    background: bool | None = None
    effort: EffortLevel | int | None = None
    permissionMode: PermissionMode | None = None
```

| Field             | Required | Description                                                                                                                                                                                                                             |
| :---------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | Yes      | Natural language description of when to use this agent                                                                                                                                                                                  |
| `prompt`          | Yes      | The agent's system prompt                                                                                                                                                                                                               |
| `tools`           | No       | Array of allowed tool names. If omitted, inherits every [tool available to subagents](/docs/en/sub-agents#available-tools)                                                                                                                   |
| `disallowedTools` | No       | Array of tool names to remove from the agent's tool set. MCP server-level patterns are also accepted: `mcp__server` or `mcp__server__*` removes every tool from that server, and `mcp__*` removes every MCP tool from any server        |
| `model`           | No       | Model override for this agent. Accepts an alias such as `"sonnet"`, `"opus"`, `"haiku"`, or `"inherit"`, or a full model ID. When you omit it, Claude Code picks the model in the [subagent model order](/docs/en/sub-agents#choose-a-model) |
| `skills`          | No       | List of skill names to preload into the agent's context at startup. Unlisted skills remain invocable through the Skill tool                                                                                                             |
| `memory`          | No       | Memory source for this agent: `"user"`, `"project"`, or `"local"`                                                                                                                                                                       |
| `mcpServers`      | No       | MCP servers available to this agent. Each entry is a server name or an inline `{name: config}` dict                                                                                                                                     |
| `initialPrompt`   | No       | Auto-submitted as the first user turn when this agent runs as the main thread agent                                                                                                                                                     |
| `maxTurns`        | No       | Maximum number of agentic turns before the agent stops                                                                                                                                                                                  |
| `background`      | No       | Run this agent as a non-blocking background task when invoked                                                                                                                                                                           |
| `effort`          | No       | Reasoning effort level for this agent. Accepts a named level or an integer. See [`EffortLevel`](#effortlevel)                                                                                                                           |
| `permissionMode`  | No       | Permission mode for tool execution within this agent. See [`PermissionMode`](#permissionmode)                                                                                                                                           |

<Note>
  `AgentDefinition` field names use camelCase, such as `disallowedTools`, `permissionMode`, and `maxTurns`. These names map directly to the wire format shared with the TypeScript SDK. This differs from `ClaudeAgentOptions`, which uses Python snake\_case for the equivalent top-level fields such as `disallowed_tools` and `permission_mode`. Because `AgentDefinition` is a dataclass, passing a snake\_case keyword raises a `TypeError` at construction time.
</Note>

### `PermissionMode`

Permission modes for controlling tool execution.

```python theme={null}
PermissionMode = Literal[
    "default",  # Standard permission behavior
    "acceptEdits",  # Auto-accept file edits
    "plan",  # Planning mode - explore without editing
    "dontAsk",  # Deny anything not pre-approved instead of prompting
    "bypassPermissions",  # Bypass permission checks; explicit ask rules still prompt (use with caution)
    "auto",  # Model classifier approves or denies permission prompts
]
```

### `EffortLevel`

Effort levels for guiding thinking depth.

```python theme={null}
EffortLevel = Literal[
    "low",  # Minimal thinking, fastest responses
    "medium",  # Moderate thinking
    "high",  # Deep reasoning
    "xhigh",  # Extended reasoning; falls back to "high" on models that don't support it
    "max",  # Maximum effort
]
```

### `CanUseTool`

Type alias for tool permission callback functions.

```python theme={null}
CanUseTool = Callable[
    [str, dict[str, Any], ToolPermissionContext], Awaitable[PermissionResult]
]
```

The callback receives:

* `tool_name`: Name of the tool being called
* `input_data`: The tool's input parameters
* `context`: A `ToolPermissionContext` with additional information

Returns a `PermissionResult` (either `PermissionResultAllow` or `PermissionResultDeny`).

The callback is the SDK replacement for the interactive permission prompt: it's invoked only when the [permission evaluation flow](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) resolves to a prompt. Tool calls already approved by an `allowed_tools` entry, a settings allow rule, or the permission mode, such as `acceptEdits` or `bypassPermissions`, never invoke it. To gate every tool call, use a [`PreToolUse` hook](/docs/en/agent-sdk/hooks) instead.

An allow rule doesn't pre-approve the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves); see [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) for which of them reach the callback and what happens in `dontAsk` and `auto` mode.

### `ToolPermissionContext`

Context information passed to tool permission callbacks.

```python theme={null}
@dataclass
class ToolPermissionContext:
    signal: Any | None = None  # Future: abort signal support
    suggestions: list[PermissionUpdate] = field(default_factory=list)
    tool_use_id: str | None = None
    agent_id: str | None = None
    blocked_path: str | None = None
    decision_reason: str | None = None
    title: str | None = None
    display_name: str | None = None
    description: str | None = None
```

| Field             | Type                     | Description                                                                                                                                                                                                                                 |
| :---------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signal`          | `Any \| None`            | Reserved for future abort signal support                                                                                                                                                                                                    |
| `suggestions`     | `list[PermissionUpdate]` | Permission update suggestions from the CLI. Bash prompts include a suggestion with the `localSettings` destination, so returning it in `updated_permissions` writes the rule to `.claude/settings.local.json` and persists across sessions. |
| `tool_use_id`     | `str \| None`            | Identifier of the specific tool call this prompt is for. Always populated when delivered to `can_use_tool`                                                                                                                                  |
| `agent_id`        | `str \| None`            | Sub-agent ID when the call originates from a subagent; `None` for the main agent                                                                                                                                                            |
| `blocked_path`    | `str \| None`            | File path that triggered the permission request, when applicable. For example, when a Bash command tries to access a path outside allowed directories                                                                                       |
| `decision_reason` | `str \| None`            | Reason this permission request was triggered. Forwarded from a PreToolUse hook's `permissionDecisionReason` when the hook returned `"ask"`                                                                                                  |
| `title`           | `str \| None`            | Full permission prompt sentence, such as `Claude wants to read foo.txt`. Use as the primary prompt text when present                                                                                                                        |
| `display_name`    | `str \| None`            | Short noun phrase for the tool action, such as `Read file`, suitable for button labels                                                                                                                                                      |
| `description`     | `str \| None`            | Human-readable subtitle for the permission UI                                                                                                                                                                                               |

### `PermissionResult`

Union type for permission callback results.

```python theme={null}
PermissionResult = PermissionResultAllow | PermissionResultDeny
```

### `PermissionResultAllow`

Result indicating the tool call should be allowed.

```python theme={null}
@dataclass
class PermissionResultAllow:
    behavior: Literal["allow"] = "allow"
    updated_input: dict[str, Any] | None = None
    updated_permissions: list[PermissionUpdate] | None = None
```

| Field                 | Type                             | Default   | Description                               |
| :-------------------- | :------------------------------- | :-------- | :---------------------------------------- |
| `behavior`            | `Literal["allow"]`               | `"allow"` | Must be "allow"                           |
| `updated_input`       | `dict[str, Any] \| None`         | `None`    | Modified input to use instead of original |
| `updated_permissions` | `list[PermissionUpdate] \| None` | `None`    | Permission updates to apply               |

### `PermissionResultDeny`

Result indicating the tool call should be denied.

```python theme={null}
@dataclass
class PermissionResultDeny:
    behavior: Literal["deny"] = "deny"
    message: str = ""
    interrupt: bool = False
```

| Field       | Type              | Default  | Description                                |
| :---------- | :---------------- | :------- | :----------------------------------------- |
| `behavior`  | `Literal["deny"]` | `"deny"` | Must be "deny"                             |
| `message`   | `str`             | `""`     | Message explaining why the tool was denied |
| `interrupt` | `bool`            | `False`  | Whether to interrupt the current execution |

### `PermissionUpdate`

Configuration for updating permissions programmatically.

```python theme={null}
@dataclass
class PermissionUpdate:
    type: Literal[
        "addRules",
        "replaceRules",
        "removeRules",
        "setMode",
        "addDirectories",
        "removeDirectories",
    ]
    rules: list[PermissionRuleValue] | None = None
    behavior: Literal["allow", "deny", "ask"] | None = None
    mode: PermissionMode | None = None
    directories: list[str] | None = None
    destination: (
        Literal["userSettings", "projectSettings", "localSettings", "session"] | None
    ) = None
```

| Field         | Type                                      | Description                                     |
| :------------ | :---------------------------------------- | :---------------------------------------------- |
| `type`        | `Literal[...]`                            | The type of permission update operation         |
| `rules`       | `list[PermissionRuleValue] \| None`       | Rules for add/replace/remove operations         |
| `behavior`    | `Literal["allow", "deny", "ask"] \| None` | Behavior for rule-based operations              |
| `mode`        | `PermissionMode \| None`                  | Mode for setMode operation                      |
| `directories` | `list[str] \| None`                       | Directories for add/remove directory operations |
| `destination` | `Literal[...] \| None`                    | Where to apply the permission update            |

### `PermissionRuleValue`

A rule to add, replace, or remove in a permission update.

```python theme={null}
@dataclass
class PermissionRuleValue:
    tool_name: str
    rule_content: str | None = None
```

### `ToolsPreset`

Preset tools configuration for using Claude Code's default tool set.

```python theme={null}
class ToolsPreset(TypedDict):
    type: Literal["preset"]
    preset: Literal["claude_code"]
```

### `ThinkingConfig`

Controls extended thinking behavior. A union of three configurations:

```python theme={null}
ThinkingDisplay = Literal["summarized", "omitted"]


class ThinkingConfigAdaptive(TypedDict):
    type: Literal["adaptive"]
    display: NotRequired[ThinkingDisplay]


class ThinkingConfigEnabled(TypedDict):
    type: Literal["enabled"]
    budget_tokens: int
    display: NotRequired[ThinkingDisplay]


class ThinkingConfigDisabled(TypedDict):
    type: Literal["disabled"]


ThinkingConfig = ThinkingConfigAdaptive | ThinkingConfigEnabled | ThinkingConfigDisabled
```

| Variant    | Fields                             | Description                                  |
| :--------- | :--------------------------------- | :------------------------------------------- |
| `adaptive` | `type`, `display`                  | Claude adaptively decides when to think      |
| `enabled`  | `type`, `budget_tokens`, `display` | Enable thinking with a specific token budget |
| `disabled` | `type`                             | Disable thinking                             |

The optional `display` field controls whether thinking text is returned `"summarized"` or `"omitted"`. On Claude Opus 4.7 and later, the API default is `"omitted"`, so set `"summarized"` to receive thinking content in [`ThinkingBlock`](#thinkingblock) outputs. Claude Code doesn't send `display` to Amazon Bedrock or Google Cloud's Agent Platform, so on those providers Opus 4.7 and later return empty `ThinkingBlock` outputs even when you set `display` to `"summarized"`.

Because these are `TypedDict` classes, they're plain dicts at runtime. Either construct them as dict literals or call the class like a constructor; both produce a `dict`. Access fields with `config["budget_tokens"]`, not `config.budget_tokens`:

```python theme={null}
from claude_agent_sdk import ClaudeAgentOptions, ThinkingConfigEnabled

# Option 1: dict literal (recommended, no import needed)
options = ClaudeAgentOptions(thinking={"type": "enabled", "budget_tokens": 20000})

# Option 2: constructor-style (returns a plain dict)
config = ThinkingConfigEnabled(type="enabled", budget_tokens=20000)
print(config["budget_tokens"])  # 20000
# config.budget_tokens would raise AttributeError
```

### `TaskBudget`

API-side task budget in tokens, used with the `task_budget` field in `ClaudeAgentOptions`.

```python theme={null}
class TaskBudget(TypedDict):
    total: int
```

| Field   | Type  | Description                     |
| :------ | :---- | :------------------------------ |
| `total` | `int` | Total token budget for the task |

Because this is a `TypedDict`, pass it as a plain dict, such as `ClaudeAgentOptions(task_budget={"total": 50000})`.

### `SdkBeta`

Literal type for SDK beta features.

```python theme={null}
SdkBeta = Literal["context-1m-2025-08-07"]
```

Use with the `betas` field in `ClaudeAgentOptions` to enable beta features.

<Warning>
  The `context-1m-2025-08-07` beta is retired as of April 30, 2026. Passing this header with Claude Sonnet 4.5 or Sonnet 4 has no effect, and requests that exceed the standard 200k-token context window return an error. To use a 1M-token context window, migrate to [Claude Opus 5, Claude Sonnet 5, Claude Sonnet 4.6, Claude Opus 4.6, Claude Opus 4.7, or Claude Opus 4.8](https://platform.claude.com/docs/en/about-claude/models/overview), which include 1M context at standard pricing with no beta header required.
</Warning>

### `McpSdkServerConfig`

Configuration for SDK MCP servers created with `create_sdk_mcp_server()`.

```python theme={null}
class McpSdkServerConfig(TypedDict):
    type: Literal["sdk"]
    name: str
    instance: Any  # MCP Server instance
```

### `McpServerConfig`

Union type for MCP server configurations.

```python theme={null}
McpServerConfig = (
    McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig
)
```

#### `McpStdioServerConfig`

```python theme={null}
class McpStdioServerConfig(TypedDict):
    type: NotRequired[Literal["stdio"]]  # Optional for backwards compatibility
    command: str
    args: NotRequired[list[str]]
    env: NotRequired[dict[str, str]]
```

#### `McpSSEServerConfig`

```python theme={null}
class McpSSEServerConfig(TypedDict):
    type: Literal["sse"]
    url: str
    headers: NotRequired[dict[str, str]]
```

#### `McpHttpServerConfig`

```python theme={null}
class McpHttpServerConfig(TypedDict):
    type: Literal["http"]
    url: str
    headers: NotRequired[dict[str, str]]
```

### `McpServerStatusConfig`

The configuration of an MCP server as reported by [`get_mcp_status()`](#methods). This is the union of all [`McpServerConfig`](#mcpserverconfig) transport variants plus an output-only `claudeai-proxy` variant for servers proxied through claude.ai.

```python theme={null}
McpServerStatusConfig = (
    McpStdioServerConfig
    | McpSSEServerConfig
    | McpHttpServerConfig
    | McpSdkServerConfigStatus
    | McpClaudeAIProxyServerConfig
)
```

`McpSdkServerConfigStatus` is the serializable form of [`McpSdkServerConfig`](#mcpsdkserverconfig) with only `type` (`"sdk"`) and `name` (`str`) fields; the in-process `instance` is omitted. `McpClaudeAIProxyServerConfig` has `type` (`"claudeai-proxy"`), `url` (`str`), and `id` (`str`) fields.

### `McpStatusResponse`

Response from [`ClaudeSDKClient.get_mcp_status()`](#methods). Wraps the list of server statuses under the `mcpServers` key.

```python theme={null}
class McpStatusResponse(TypedDict):
    mcpServers: list[McpServerStatus]
```

### `McpServerStatus`

Status of a connected MCP server, contained in [`McpStatusResponse`](#mcpstatusresponse).

```python theme={null}
class McpServerStatus(TypedDict):
    name: str
    status: McpServerConnectionStatus  # "connected" | "failed" | "needs-auth" | "pending" | "disabled"
    serverInfo: NotRequired[McpServerInfo]
    error: NotRequired[str]
    config: NotRequired[McpServerStatusConfig]
    scope: NotRequired[str]
    tools: NotRequired[list[McpToolInfo]]
```

| Field        | Type                                                         | Description                                                                                                                                                                   |
| :----------- | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | `str`                                                        | Server name                                                                                                                                                                   |
| `status`     | `str`                                                        | One of `"connected"`, `"failed"`, `"needs-auth"`, `"pending"`, or `"disabled"`                                                                                                |
| `serverInfo` | `dict` (optional)                                            | Server name and version (`{"name": str, "version": str}`)                                                                                                                     |
| `error`      | `str` (optional)                                             | Error message if the server failed to connect                                                                                                                                 |
| `config`     | [`McpServerStatusConfig`](#mcpserverstatusconfig) (optional) | Server configuration. Same shape as [`McpServerConfig`](#mcpserverconfig) (stdio, SSE, HTTP, or SDK), plus a `claudeai-proxy` variant for servers connected through claude.ai |
| `scope`      | `str` (optional)                                             | Configuration scope                                                                                                                                                           |
| `tools`      | `list` (optional)                                            | Tools provided by this server, each with `name`, `description`, and `annotations` fields                                                                                      |

### `SdkPluginConfig`

Configuration for loading plugins in the SDK.

```python theme={null}
class SdkPluginConfig(TypedDict):
    type: Literal["local"]
    path: str
```

| Field  | Type               | Description                                                |
| :----- | :----------------- | :--------------------------------------------------------- |
| `type` | `Literal["local"]` | Must be `"local"` (only local plugins currently supported) |
| `path` | `str`              | Absolute or relative path to the plugin directory          |

**Example:**

```python theme={null}
plugins = [
    {"type": "local", "path": "./my-plugin"},
    {"type": "local", "path": "/absolute/path/to/plugin"},
]
```

For complete information on creating and using plugins, see [Plugins](/docs/en/agent-sdk/plugins).

## Message Types

### `Message`

Union type of all possible messages.

```python theme={null}
Message = (
    UserMessage
    | AssistantMessage
    | SystemMessage
    | ResultMessage
    | StreamEvent
    | RateLimitEvent
    | ConversationResetMessage
)
```

### `UserMessage`

User input message.

```python theme={null}
@dataclass
class UserMessage:
    content: str | list[ContentBlock]
    uuid: str | None = None
    parent_tool_use_id: str | None = None
    tool_use_result: dict[str, Any] | None = None
    origin: MessageOrigin | None = None
```

| Field                | Type                        | Description                                                                                                                                                                               |
| :------------------- | :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`            | `str \| list[ContentBlock]` | Message content as text or content blocks                                                                                                                                                 |
| `uuid`               | `str \| None`               | Unique message identifier                                                                                                                                                                 |
| `parent_tool_use_id` | `str \| None`               | Tool use ID if this message is a tool result response                                                                                                                                     |
| `tool_use_result`    | `dict[str, Any] \| None`    | Tool result data if applicable                                                                                                                                                            |
| `origin`             | `MessageOrigin \| None`     | Provenance of this message, populated on injected turns such as task notifications and peer messages. `None` when the CLI didn't attribute it. Requires Python Agent SDK 0.2.137 or later |

The SDK passes `tool_use_result` through from the CLI unmodified. For a tool on an external MCP server whose result contains `resource_link` blocks, the dict has a `resourceLinks` key holding a list of dicts with the keys of the TypeScript [`SDKMcpResourceLink`](/docs/en/agent-sdk/typescript#sdkmcpresourcelink) type. Claude receives each link as a line of text in the tool result. To render the files the server returned, read `resourceLinks` instead of parsing that text. The `resourceLinks` key requires Python Agent SDK 0.2.150 or later and Claude Code v2.1.257 or later; the CLI bundled with that SDK version satisfies the Claude Code requirement.

The CLI omits the key when the result has no links and on results from subagents. The CLI keeps at most 50 links per result and stops adding links once the list reaches 64 KiB of serialized JSON. A tool you define in-process with [`tool()`](#tool) never produces the key, because the SDK flattens its `resource_link` blocks to text before the CLI sees the result.

### `AssistantMessage`

Assistant response message with content blocks.

```python theme={null}
@dataclass
class AssistantMessage:
    content: list[ContentBlock]
    model: str
    parent_tool_use_id: str | None = None
    error: AssistantMessageError | None = None
    usage: dict[str, Any] | None = None
    message_id: str | None = None
    stop_reason: str | None = None
    session_id: str | None = None
    uuid: str | None = None
```

| Field                | Type                                                         | Description                                                                    |
| :------------------- | :----------------------------------------------------------- | :----------------------------------------------------------------------------- |
| `content`            | `list[ContentBlock]`                                         | List of content blocks in the response                                         |
| `model`              | `str`                                                        | Model that generated the response                                              |
| `parent_tool_use_id` | `str \| None`                                                | Tool use ID if this is a nested response                                       |
| `error`              | [`AssistantMessageError`](#assistantmessageerror) ` \| None` | Error type if the response encountered an error                                |
| `usage`              | `dict[str, Any] \| None`                                     | Per-message token usage (same keys as [`ResultMessage.usage`](#resultmessage)) |
| `message_id`         | `str \| None`                                                | API message ID. Multiple messages from one turn share the same ID              |
| `stop_reason`        | `str \| None`                                                | Stop reason from the API (e.g. `end_turn`, `tool_use`)                         |
| `session_id`         | `str \| None`                                                | ID of the session this message belongs to                                      |
| `uuid`               | `str \| None`                                                | Unique message identifier within the session transcript                        |

### `AssistantMessageError`

Possible error types for assistant messages.

```python theme={null}
AssistantMessageError = Literal[
    "authentication_failed",
    "billing_error",
    "rate_limit",
    "invalid_request",
    "server_error",
    "unknown",
]
```

The underlying CLI process can emit error types this Literal doesn't list, such as `max_output_tokens`. The SDK passes the value through unmodified, so treat strings outside this list the way you treat `unknown`. The TypeScript [`SDKAssistantMessageError`](/docs/en/agent-sdk/typescript#sdkassistantmessage) type lists the full set of values the CLI can emit.

### `SystemMessage`

System message with metadata.

```python theme={null}
@dataclass
class SystemMessage:
    subtype: str
    data: dict[str, Any]
```

### `ResultMessage`

Final result message with cost and usage information.

```python theme={null}
@dataclass
class ResultMessage:
    subtype: str
    duration_ms: int
    duration_api_ms: int
    is_error: bool
    num_turns: int
    session_id: str
    stop_reason: str | None = None
    total_cost_usd: float | None = None
    usage: dict[str, Any] | None = None
    result: str | None = None
    structured_output: Any = None
    model_usage: dict[str, ModelUsage] | None = None
    permission_denials: list[Any] | None = None
    deferred_tool_use: DeferredToolUse | None = None
    errors: list[str] | None = None
    api_error_status: int | None = None
    uuid: str | None = None
    terminal_reason: str | None = None
    origin: MessageOrigin | None = None
```

The `subtype` field determines which other fields are populated. It is one of `"success"`, `"error_during_execution"`, `"error_max_turns"`, `"error_max_budget_usd"`, or `"error_max_structured_output_retries"`. The Python dataclass flattens all variants into one shape, so fields that don't apply to the returned subtype are `None`.

Several fields carry diagnostic detail about how the conversation ended:

* `is_error`: `True` when the conversation ended in an error state. Always `True` on the `error_*` subtypes. On `subtype="success"` it is `True` when the final model request failed, meaning the agent loop completed but the last API call returned an error.
* `api_error_status`: the HTTP status code of the terminating API error. `None` when the turn ended without one. Populated only on `subtype="success"`.
* `result`: text of the final assistant message on `subtype="success"`, or `None` on the `error_*` subtypes. When `subtype="success"` and `is_error=True`, this holds the API error string if one is available but can be empty, so check `api_error_status` and the preceding `AssistantMessage` content for detail.
* `errors`: loop-level error strings such as the max-turns message. Populated only on the `error_*` subtypes.
* `terminal_reason`: why the query loop ended, such as `"completed"`, `"max_turns"`, `"api_error"`, `"aborted_streaming"`, or `"aborted_tools"`. A value of `"aborted_streaming"` or `"aborted_tools"` means the turn was aborted before completing. Common causes are [`interrupt()`](#claudesdkclient) and a permission callback returning [`PermissionResultDeny`](#permissionresultdeny) with `interrupt=True`. `None` on CLI versions that predate the field, on results from local commands such as `/voice` or `/usage`, which bypass the query loop, or on synthesized error results emitted when the session fails fatally. Mirrors the TypeScript SDK's [`SDKResultMessage.terminal_reason`](/docs/en/agent-sdk/typescript#sdkresultmessage), which lists the full set of values.
* `origin`: origin of the user message that triggered this turn. In [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), check this to tell the result of your own prompt, where `origin` is `None` or `{"kind": "human"}`, from the result of an injected turn such as a background-task notification. Requires Python Agent SDK 0.2.137 or later.

The `usage` dict covers the main agent loop only and excludes subagent and other nested or auxiliary model calls. In [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), the values are per-turn. Prefer `model_usage` for token and cost accounting. The `usage` dict contains the following keys when present:

| Key                           | Type  | Description                                                                                                                                                                                   |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input_tokens`                | `int` | Input tokens consumed by the top-level agent loop. [Subagent tokens aren't included](/docs/en/agent-sdk/cost-tracking#get-the-total-cost-of-a-query); use `model_usage` for whole-tree accounting. |
| `output_tokens`               | `int` | Output tokens generated by the top-level agent loop. Subagent tokens aren't included.                                                                                                         |
| `cache_creation_input_tokens` | `int` | Tokens used to create new cache entries.                                                                                                                                                      |
| `cache_read_input_tokens`     | `int` | Tokens read from existing cache entries.                                                                                                                                                      |

The `model_usage` dict maps model names to per-model usage. It covers every model call made through the query pipeline: the main loop, subagents, and internal calls such as compaction and Workflow agents. Helper calls outside that pipeline, such as the permission classifier and token-counting requests, are excluded from `model_usage`. Treat `model_usage` as an estimate, not a billing statement.

In [streaming input mode](/docs/en/agent-sdk/streaming-vs-single-mode), `model_usage` and `total_cost_usd` are cumulative across turns, so read the latest result rather than summing across results. See [Track costs in streaming input mode](/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode) for resets and [Recover totals after a session crash](/docs/en/agent-sdk/cost-tracking#recover-totals-after-a-session-crash) for zeroed results.

Each value in `model_usage` is a `ModelUsage` TypedDict, imported via `from claude_agent_sdk.types import ModelUsage`. Its keys use camelCase because the SDK passes the value through unmodified from the underlying CLI process, matching the TypeScript [`ModelUsage`](/docs/en/agent-sdk/typescript#modelusage) type:

| Key                        | Type    | Description                                                                                                                                                                                                                                                                           |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputTokens`              | `int`   | Input tokens for this model.                                                                                                                                                                                                                                                          |
| `outputTokens`             | `int`   | Output tokens for this model.                                                                                                                                                                                                                                                         |
| `cacheReadInputTokens`     | `int`   | Cache read tokens for this model.                                                                                                                                                                                                                                                     |
| `cacheCreationInputTokens` | `int`   | Cache creation tokens for this model.                                                                                                                                                                                                                                                 |
| `webSearchRequests`        | `int`   | Web search requests made by this model.                                                                                                                                                                                                                                               |
| `thinkingTokens`           | `int`   | Thinking tokens generated by this model, already counted in `outputTokens`. Absent until a turn runs on a Claude Code version that records it, and not declared on the TypedDict, so read it with `.get()`. Requires Python Agent SDK 0.2.150 or later, whose bundled CLI records it. |
| `costUSD`                  | `float` | Estimated cost in USD for this model, computed client-side. See [Track cost and usage](/docs/en/agent-sdk/cost-tracking) for billing caveats.                                                                                                                                              |
| `contextWindow`            | `int`   | Context window size for this model.                                                                                                                                                                                                                                                   |
| `maxOutputTokens`          | `int`   | Maximum output token limit for this model.                                                                                                                                                                                                                                            |
| `canonicalModel`           | `str`   | Canonical model ID used for the pricing lookup. May differ from the raw model string the entry is keyed by, such as a provider-specific ID or alias. Not always present.                                                                                                              |
| `provider`                 | `str`   | API provider that served this model, such as `firstParty`, `bedrock`, `vertex`, `foundry`, `anthropicAws`, `mantle`, or `gateway`. Not always present.                                                                                                                                |

### `StreamEvent`

Stream event for partial message updates during streaming. Only received when `include_partial_messages=True` in `ClaudeAgentOptions`. Import via `from claude_agent_sdk.types import StreamEvent`.

```python theme={null}
@dataclass
class StreamEvent:
    uuid: str
    session_id: str
    event: dict[str, Any]  # The raw Claude API stream event
    parent_tool_use_id: str | None = None
```

| Field                | Type             | Description                                                                                                                                                         |
| :------------------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uuid`               | `str`            | Unique identifier for this event                                                                                                                                    |
| `session_id`         | `str`            | Session identifier                                                                                                                                                  |
| `event`              | `dict[str, Any]` | The raw Claude API stream event data                                                                                                                                |
| `parent_tool_use_id` | `str \| None`    | Always `None`. Stream events are emitted for the main session only. For subagent attribution, use complete messages such as [`AssistantMessage`](#assistantmessage) |

### `RateLimitEvent`

Emitted when rate limit status changes (for example, from `"allowed"` to `"allowed_warning"`). Use this to warn users before they hit a hard limit, or to back off when status is `"rejected"`.

```python theme={null}
@dataclass
class RateLimitEvent:
    rate_limit_info: RateLimitInfo
    uuid: str
    session_id: str
```

| Field             | Type                              | Description              |
| :---------------- | :-------------------------------- | :----------------------- |
| `rate_limit_info` | [`RateLimitInfo`](#ratelimitinfo) | Current rate limit state |
| `uuid`            | `str`                             | Unique event identifier  |
| `session_id`      | `str`                             | Session identifier       |

### `RateLimitInfo`

Rate limit state carried by [`RateLimitEvent`](#ratelimitevent).

```python theme={null}
RateLimitStatus = Literal["allowed", "allowed_warning", "rejected"]
RateLimitType = Literal[
    "five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"
]


@dataclass
class RateLimitInfo:
    status: RateLimitStatus
    resets_at: int | None = None
    rate_limit_type: RateLimitType | None = None
    utilization: float | None = None
    overage_status: RateLimitStatus | None = None
    overage_resets_at: int | None = None
    overage_disabled_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
```

| Field                     | Type                      | Description                                                                                           |
| :------------------------ | :------------------------ | :---------------------------------------------------------------------------------------------------- |
| `status`                  | `RateLimitStatus`         | Current status. `"allowed_warning"` means approaching the limit; `"rejected"` means the limit was hit |
| `resets_at`               | `int \| None`             | Unix timestamp when the rate limit window resets                                                      |
| `rate_limit_type`         | `RateLimitType \| None`   | Which rate limit window applies                                                                       |
| `utilization`             | `float \| None`           | Fraction of the rate limit consumed (0.0 to 1.0)                                                      |
| `overage_status`          | `RateLimitStatus \| None` | Status of pay-as-you-go overage usage, if applicable                                                  |
| `overage_resets_at`       | `int \| None`             | Unix timestamp when the overage window resets                                                         |
| `overage_disabled_reason` | `str \| None`             | Why overage is unavailable, if status is `"rejected"`                                                 |
| `raw`                     | `dict[str, Any]`          | Full raw dict from the CLI, including fields not modeled above                                        |

### `ConversationResetMessage`

Emitted when the conversation is replaced without ending the connection, such as after `/clear`. See [Track costs in streaming input mode](/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode) for how a reset affects the running totals on later `ResultMessage` objects. Requires Python Agent SDK 0.2.137 or later.

```python theme={null}
@dataclass
class ConversationResetMessage:
    new_conversation_id: str
    uuid: str
    session_id: str
```

| Field                 | Type  | Description                                                                                                                |
| :-------------------- | :---- | :------------------------------------------------------------------------------------------------------------------------- |
| `new_conversation_id` | `str` | Opaque identifier for the fresh conversation. Not the `session_id` of subsequent messages; read that from the next message |
| `uuid`                | `str` | Unique message identifier                                                                                                  |
| `session_id`          | `str` | ID of the session that was reset. Messages after the reset carry a new `session_id`                                        |

### `TaskStartedMessage`

Emitted when a background task starts. A background task is anything tracked outside the main turn: a backgrounded Bash command, a [Monitor](#monitor) watch, a subagent spawned via the Agent tool, or a remote agent. The `task_type` field tells you which. This naming is unrelated to the `Task`-to-`Agent` tool rename.

```python theme={null}
@dataclass
class TaskStartedMessage(SystemMessage):
    task_id: str
    description: str
    uuid: str
    session_id: str
    tool_use_id: str | None = None
    task_type: str | None = None
```

| Field         | Type          | Description                                                                                                                 |
| :------------ | :------------ | :-------------------------------------------------------------------------------------------------------------------------- |
| `task_id`     | `str`         | Unique identifier for the task                                                                                              |
| `description` | `str`         | Description of the task                                                                                                     |
| `uuid`        | `str`         | Unique message identifier                                                                                                   |
| `session_id`  | `str`         | Session identifier                                                                                                          |
| `tool_use_id` | `str \| None` | Associated tool use ID                                                                                                      |
| `task_type`   | `str \| None` | Which kind of background task: `"local_bash"` for background Bash and Monitor watches, `"local_agent"`, or `"remote_agent"` |

### `TaskUsage`

Token and timing data for a background task.

```python theme={null}
class TaskUsage(TypedDict):
    total_tokens: int
    tool_uses: int
    duration_ms: int
```

### `TaskProgressMessage`

Emitted periodically with progress updates for a running background task.

```python theme={null}
@dataclass
class TaskProgressMessage(SystemMessage):
    task_id: str
    description: str
    usage: TaskUsage
    uuid: str
    session_id: str
    tool_use_id: str | None = None
    last_tool_name: str | None = None
```

| Field            | Type          | Description                         |
| :--------------- | :------------ | :---------------------------------- |
| `task_id`        | `str`         | Unique identifier for the task      |
| `description`    | `str`         | Current status description          |
| `usage`          | `TaskUsage`   | Token usage for this task so far    |
| `uuid`           | `str`         | Unique message identifier           |
| `session_id`     | `str`         | Session identifier                  |
| `tool_use_id`    | `str \| None` | Associated tool use ID              |
| `last_tool_name` | `str \| None` | Name of the last tool the task used |

### `TaskNotificationMessage`

Emitted when a background task completes, fails, or is stopped. Background tasks include `run_in_background` Bash commands, Monitor watches, and background subagents.

```python theme={null}
@dataclass
class TaskNotificationMessage(SystemMessage):
    task_id: str
    status: TaskNotificationStatus  # "completed" | "failed" | "stopped"
    output_file: str
    summary: str
    uuid: str
    session_id: str
    tool_use_id: str | None = None
    usage: TaskUsage | None = None
```

| Field         | Type                     | Description                                      |
| :------------ | :----------------------- | :----------------------------------------------- |
| `task_id`     | `str`                    | Unique identifier for the task                   |
| `status`      | `TaskNotificationStatus` | One of `"completed"`, `"failed"`, or `"stopped"` |
| `output_file` | `str`                    | Path to the task output file                     |
| `summary`     | `str`                    | Summary of the task result                       |
| `uuid`        | `str`                    | Unique message identifier                        |
| `session_id`  | `str`                    | Session identifier                               |
| `tool_use_id` | `str \| None`            | Associated tool use ID                           |
| `usage`       | `TaskUsage \| None`      | Final token usage for the task                   |

When the CLI [moves a long MCP tool call to the background](/docs/en/mcp#automatic-backgrounding-of-long-tool-calls), the tool result for that call holds only a placeholder and the call's real result arrives in this message. On a `"completed"` notification for such a call, the CLI adds a `resource_links` key listing the files the tool returned by reference, with the same entries and limits as the `resourceLinks` key on [`UserMessage.tool_use_result`](#usermessage). The `resource_links` key requires Python Agent SDK 0.2.150 or later and Claude Code v2.1.257 or later; the CLI bundled with that SDK version satisfies the Claude Code requirement.

The dataclass has no field for `resource_links`. Read it from the `data` dict the message inherits from [`SystemMessage`](#systemmessage): `message.data.get("resource_links")`. Match the notification to the call with `tool_use_id`. The CLI omits the key when the result had no links and on notifications for tasks that aren't MCP tool calls.

## Content Block Types

### `ContentBlock`

Union type of all content blocks.

```python theme={null}
ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock
```

### `TextBlock`

Text content block.

```python theme={null}
@dataclass
class TextBlock:
    text: str
```

### `ThinkingBlock`

Thinking content block (for models with thinking capability).

```python theme={null}
@dataclass
class ThinkingBlock:
    thinking: str
    signature: str
```

### `ToolUseBlock`

Tool use request block.

```python theme={null}
@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
```

### `ToolResultBlock`

Tool execution result block.

```python theme={null}
@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: str | list[dict[str, Any]] | None = None
    is_error: bool | None = None
```

## Error Types

The types below define what your code catches. For entries keyed to the error messages these types raise, with the cause and fix for each, see [Troubleshooting](/docs/en/agent-sdk/troubleshooting).

### `ClaudeSDKError`

Base exception class for all SDK errors.

```python theme={null}
class ClaudeSDKError(Exception):
    """Base error for Claude SDK."""
```

When a single-shot `query()` ends with an error result, for example a turn-limit error, the SDK raises a [`ResultError`](#resulterror) after yielding the final result message. Python Agent SDK versions before 0.2.140 raised a plain `Exception` that wasn't a `ClaudeSDKError` subclass.

### `CLINotFoundError`

Raised when Claude Code CLI is not installed or not found.

```python theme={null}
class CLINotFoundError(CLIConnectionError):
    def __init__(
        self, message: str = "Claude Code not found", cli_path: str | None = None
    ):
        """
        Args:
            message: Error message (default: "Claude Code not found")
            cli_path: Optional path to the CLI that was not found
        """
```

### `CLIConnectionError`

Raised when connection to Claude Code fails.

```python theme={null}
class CLIConnectionError(ClaudeSDKError):
    """Failed to connect to Claude Code."""
```

### `ProcessError`

Raised when the Claude Code process fails.

```python theme={null}
class ProcessError(ClaudeSDKError):
    def __init__(
        self, message: str, exit_code: int | None = None, stderr: str | None = None
    ):
        self.exit_code = exit_code
        self.stderr = stderr
```

### `ResultError`

Raised after the final [`ResultMessage`](#resultmessage) when the Claude Code process exits because the run ended with an error result, such as a turn-limit error or an API error. `ResultError` subclasses `ProcessError`, so an existing `except ProcessError` handler also catches it. Its attributes carry the fields of that result message, so you can branch on why the run failed without parsing the message text. Requires Python Agent SDK 0.2.140 or later.

```python theme={null}
class ResultError(ProcessError):
    subtype: str | None  # "error_max_turns", "error_during_execution", ...; "success" when the run ended on a failed request
    errors: list[str]  # an empty list when the result message reported none
    result: str | None
    api_error_status: int | None
    terminal_reason: str | None  # "max_turns", "api_error", ...; check this before subtype
    session_id: str | None
    data: dict[str, Any]  # the raw result message payload
```

To tell failures apart, check `terminal_reason` before `subtype`. When the final request fails, such as on an API error, Claude Code reports `subtype` `"success"` with the cause in `terminal_reason`, for example `"api_error"`; when a limit you set ends the run, such as `max_turns` or `max_budget_usd`, it reports an `error_*` subtype.

### `CLIJSONDecodeError`

Raised when JSON parsing fails.

```python theme={null}
class CLIJSONDecodeError(ClaudeSDKError):
    def __init__(self, line: str, original_error: Exception):
        """
        Args:
            line: The line that failed to parse
            original_error: The original JSON decode exception
        """
        self.line = line
        self.original_error = original_error
```

## Hook Types

For a comprehensive guide on using hooks with examples and common patterns, see the [Hooks guide](/docs/en/agent-sdk/hooks).

### `HookEvent`

Supported hook event types.

```python theme={null}
HookEvent = Literal[
    "PreToolUse",  # Called before tool execution
    "PostToolUse",  # Called after tool execution
    "PostToolUseFailure",  # Called when a tool execution fails
    "UserPromptSubmit",  # Called when user submits a prompt
    "Stop",  # Called when stopping execution
    "SubagentStop",  # Called when a subagent stops
    "PreCompact",  # Called before message compaction
    "Notification",  # Called for notification events
    "SubagentStart",  # Called when a subagent starts
    "PermissionRequest",  # Called when a permission decision is needed
]
```

<Note>
  The TypeScript SDK supports additional hook events not yet available in Python. See the [hook availability table](/docs/en/agent-sdk/hooks#available-hooks) for per-SDK support.
</Note>

### `HookCallback`

Type definition for hook callback functions.

```python theme={null}
HookCallback = Callable[[HookInput, str | None, HookContext], Awaitable[HookJSONOutput]]
```

Parameters:

* `input`: Strongly-typed hook input with discriminated unions based on `hook_event_name` (see [`HookInput`](#hookinput))
* `tool_use_id`: Optional tool use identifier (for tool-related hooks)
* `context`: Hook context with additional information

Returns a [`HookJSONOutput`](#hookjsonoutput).

### `HookContext`

Context information passed to hook callbacks.

```python theme={null}
class HookContext(TypedDict):
    signal: Any | None  # Future: abort signal support
```

### `HookMatcher`

Configuration for matching hooks to specific events or tools.

```python theme={null}
@dataclass
class HookMatcher:
    matcher: str | None = (
        None  # Tool name or pattern to match (e.g., "Bash", "Write|Edit")
    )
    hooks: list[HookCallback] = field(
        default_factory=list
    )  # List of callbacks to execute
    timeout: float | None = (
        None  # Timeout in seconds. When omitted, the per-event default applies:
        # 600 for most events, 30 for UserPromptSubmit
    )
```

### `HookInput`

Union type of all hook input types. The actual type depends on the `hook_event_name` field.

```python theme={null}
HookInput = (
    PreToolUseHookInput
    | PostToolUseHookInput
    | PostToolUseFailureHookInput
    | UserPromptSubmitHookInput
    | StopHookInput
    | SubagentStopHookInput
    | PreCompactHookInput
    | NotificationHookInput
    | SubagentStartHookInput
    | PermissionRequestHookInput
)
```

### `BaseHookInput`

Base fields present in all hook input types.

```python theme={null}
class BaseHookInput(TypedDict):
    session_id: str
    transcript_path: str
    cwd: str
    permission_mode: NotRequired[str]
```

| Field             | Type             | Description                         |
| :---------------- | :--------------- | :---------------------------------- |
| `session_id`      | `str`            | Current session identifier          |
| `transcript_path` | `str`            | Path to the session transcript file |
| `cwd`             | `str`            | Current working directory           |
| `permission_mode` | `str` (optional) | Current permission mode             |

### `PreToolUseHookInput`

Input data for `PreToolUse` hook events.

```python theme={null}
class PreToolUseHookInput(BaseHookInput):
    hook_event_name: Literal["PreToolUse"]
    tool_name: str
    tool_input: dict[str, Any]
    tool_use_id: str
    agent_id: NotRequired[str]
    agent_type: NotRequired[str]
```

| Field             | Type                    | Description                                                        |
| :---------------- | :---------------------- | :----------------------------------------------------------------- |
| `hook_event_name` | `Literal["PreToolUse"]` | Always "PreToolUse"                                                |
| `tool_name`       | `str`                   | Name of the tool about to be executed                              |
| `tool_input`      | `dict[str, Any]`        | Input parameters for the tool                                      |
| `tool_use_id`     | `str`                   | Unique identifier for this tool use                                |
| `agent_id`        | `str` (optional)        | Subagent identifier, present when the hook fires inside a subagent |
| `agent_type`      | `str` (optional)        | Subagent type, present when the hook fires inside a subagent       |

### `PostToolUseHookInput`

Input data for `PostToolUse` hook events.

```python theme={null}
class PostToolUseHookInput(BaseHookInput):
    hook_event_name: Literal["PostToolUse"]
    tool_name: str
    tool_input: dict[str, Any]
    tool_response: Any
    tool_use_id: str
    agent_id: NotRequired[str]
    agent_type: NotRequired[str]
```

| Field             | Type                     | Description                                                        |
| :---------------- | :----------------------- | :----------------------------------------------------------------- |
| `hook_event_name` | `Literal["PostToolUse"]` | Always "PostToolUse"                                               |
| `tool_name`       | `str`                    | Name of the tool that was executed                                 |
| `tool_input`      | `dict[str, Any]`         | Input parameters that were used                                    |
| `tool_response`   | `Any`                    | Response from the tool execution                                   |
| `tool_use_id`     | `str`                    | Unique identifier for this tool use                                |
| `agent_id`        | `str` (optional)         | Subagent identifier, present when the hook fires inside a subagent |
| `agent_type`      | `str` (optional)         | Subagent type, present when the hook fires inside a subagent       |

### `PostToolUseFailureHookInput`

Input data for `PostToolUseFailure` hook events. Called when a tool execution fails.

```python theme={null}
class PostToolUseFailureHookInput(BaseHookInput):
    hook_event_name: Literal["PostToolUseFailure"]
    tool_name: str
    tool_input: dict[str, Any]
    tool_use_id: str
    error: str
    is_interrupt: NotRequired[bool]
    agent_id: NotRequired[str]
    agent_type: NotRequired[str]
```

| Field             | Type                            | Description                                                                                                                                                                                                                     |
| :---------------- | :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hook_event_name` | `Literal["PostToolUseFailure"]` | Always "PostToolUseFailure"                                                                                                                                                                                                     |
| `tool_name`       | `str`                           | Name of the tool that failed                                                                                                                                                                                                    |
| `tool_input`      | `dict[str, Any]`                | Input parameters that were used                                                                                                                                                                                                 |
| `tool_use_id`     | `str`                           | Unique identifier for this tool use                                                                                                                                                                                             |
| `error`           | `str`                           | Error message from the failed execution                                                                                                                                                                                         |
| `is_interrupt`    | `bool` (optional)               | True when the failure reached Claude Code as an abort rather than as an error the tool reported. Cancelling a running tool with `interrupt()` does not fire this hook; the tool result carries the interruption message instead |
| `agent_id`        | `str` (optional)                | Subagent identifier, present when the hook fires inside a subagent                                                                                                                                                              |
| `agent_type`      | `str` (optional)                | Subagent type, present when the hook fires inside a subagent                                                                                                                                                                    |

### `UserPromptSubmitHookInput`

Input data for `UserPromptSubmit` hook events.

```python theme={null}
class UserPromptSubmitHookInput(BaseHookInput):
    hook_event_name: Literal["UserPromptSubmit"]
    prompt: str
```

| Field             | Type                          | Description                 |
| :---------------- | :---------------------------- | :-------------------------- |
| `hook_event_name` | `Literal["UserPromptSubmit"]` | Always "UserPromptSubmit"   |
| `prompt`          | `str`                         | The user's submitted prompt |

### `StopHookInput`

Input data for `Stop` hook events.

```python theme={null}
class StopHookInput(BaseHookInput):
    hook_event_name: Literal["Stop"]
    stop_hook_active: bool
```

| Field              | Type              | Description                     |
| :----------------- | :---------------- | :------------------------------ |
| `hook_event_name`  | `Literal["Stop"]` | Always "Stop"                   |
| `stop_hook_active` | `bool`            | Whether the stop hook is active |

### `SubagentStopHookInput`

Input data for `SubagentStop` hook events.

```python theme={null}
class SubagentStopHookInput(BaseHookInput):
    hook_event_name: Literal["SubagentStop"]
    stop_hook_active: bool
    agent_id: str
    agent_transcript_path: str
    agent_type: str
```

| Field                   | Type                      | Description                            |
| :---------------------- | :------------------------ | :------------------------------------- |
| `hook_event_name`       | `Literal["SubagentStop"]` | Always "SubagentStop"                  |
| `stop_hook_active`      | `bool`                    | Whether the stop hook is active        |
| `agent_id`              | `str`                     | Unique identifier for the subagent     |
| `agent_transcript_path` | `str`                     | Path to the subagent's transcript file |
| `agent_type`            | `str`                     | Type of the subagent                   |

### `PreCompactHookInput`

Input data for `PreCompact` hook events.

```python theme={null}
class PreCompactHookInput(BaseHookInput):
    hook_event_name: Literal["PreCompact"]
    trigger: Literal["manual", "auto"]
    custom_instructions: str | None
```

| Field                 | Type                        | Description                        |
| :-------------------- | :-------------------------- | :--------------------------------- |
| `hook_event_name`     | `Literal["PreCompact"]`     | Always "PreCompact"                |
| `trigger`             | `Literal["manual", "auto"]` | What triggered the compaction      |
| `custom_instructions` | `str \| None`               | Custom instructions for compaction |

### `NotificationHookInput`

Input data for `Notification` hook events.

```python theme={null}
class NotificationHookInput(BaseHookInput):
    hook_event_name: Literal["Notification"]
    message: str
    title: NotRequired[str]
    notification_type: str
```

| Field               | Type                      | Description                  |
| :------------------ | :------------------------ | :--------------------------- |
| `hook_event_name`   | `Literal["Notification"]` | Always "Notification"        |
| `message`           | `str`                     | Notification message content |
| `title`             | `str` (optional)          | Notification title           |
| `notification_type` | `str`                     | Type of notification         |

### `SubagentStartHookInput`

Input data for `SubagentStart` hook events.

```python theme={null}
class SubagentStartHookInput(BaseHookInput):
    hook_event_name: Literal["SubagentStart"]
    agent_id: str
    agent_type: str
```

| Field             | Type                       | Description                        |
| :---------------- | :------------------------- | :--------------------------------- |
| `hook_event_name` | `Literal["SubagentStart"]` | Always "SubagentStart"             |
| `agent_id`        | `str`                      | Unique identifier for the subagent |
| `agent_type`      | `str`                      | Type of the subagent               |

### `PermissionRequestHookInput`

Input data for `PermissionRequest` hook events. Allows hooks to handle permission decisions programmatically.

```python theme={null}
class PermissionRequestHookInput(BaseHookInput):
    hook_event_name: Literal["PermissionRequest"]
    tool_name: str
    tool_input: dict[str, Any]
    permission_suggestions: NotRequired[list[Any]]
    agent_id: NotRequired[str]
    agent_type: NotRequired[str]
```

| Field                    | Type                           | Description                                                        |
| :----------------------- | :----------------------------- | :----------------------------------------------------------------- |
| `hook_event_name`        | `Literal["PermissionRequest"]` | Always "PermissionRequest"                                         |
| `tool_name`              | `str`                          | Name of the tool requesting permission                             |
| `tool_input`             | `dict[str, Any]`               | Input parameters for the tool                                      |
| `permission_suggestions` | `list[Any]` (optional)         | Suggested permission updates from the CLI                          |
| `agent_id`               | `str` (optional)               | Subagent identifier, present when the hook fires inside a subagent |
| `agent_type`             | `str` (optional)               | Subagent type, present when the hook fires inside a subagent       |

### `HookJSONOutput`

Union type for hook callback return values.

```python theme={null}
HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput
```

#### `SyncHookJSONOutput`

Synchronous hook output with control and decision fields.

```python theme={null}
class SyncHookJSONOutput(TypedDict):
    # Control fields
    continue_: NotRequired[bool]  # Whether to proceed (default: True)
    suppressOutput: NotRequired[bool]  # Hide stdout from transcript
    stopReason: NotRequired[str]  # Message when continue is False

    # Decision fields
    decision: NotRequired[Literal["block"]]
    systemMessage: NotRequired[str]  # Warning message for user
    reason: NotRequired[str]  # Feedback for Claude

    # Hook-specific output
    hookSpecificOutput: NotRequired[HookSpecificOutput]
```

<Note>
  Use `continue_` (with underscore) in Python code. It is automatically converted to `continue` when sent to the CLI.
</Note>

#### `HookSpecificOutput`

A discriminated union of event-specific `TypedDict` output types. The `hookEventName` field determines which fields are valid. For full details on available fields per hook event, see [Control execution with hooks](/docs/en/agent-sdk/hooks#outputs).

```python theme={null}
class PreToolUseHookSpecificOutput(TypedDict):
    hookEventName: Literal["PreToolUse"]
    permissionDecision: NotRequired[Literal["allow", "deny", "ask", "defer"]]
    permissionDecisionReason: NotRequired[str]
    updatedInput: NotRequired[dict[str, Any]]
    additionalContext: NotRequired[str]


class PostToolUseHookSpecificOutput(TypedDict):
    hookEventName: Literal["PostToolUse"]
    additionalContext: NotRequired[str]
    updatedToolOutput: NotRequired[Any]
    updatedMCPToolOutput: NotRequired[Any]  # Deprecated: use updatedToolOutput, which works for all tools


class PostToolUseFailureHookSpecificOutput(TypedDict):
    hookEventName: Literal["PostToolUseFailure"]
    additionalContext: NotRequired[str]


class UserPromptSubmitHookSpecificOutput(TypedDict):
    hookEventName: Literal["UserPromptSubmit"]
    additionalContext: NotRequired[str]


class NotificationHookSpecificOutput(TypedDict):
    hookEventName: Literal["Notification"]
    additionalContext: NotRequired[str]


class SubagentStartHookSpecificOutput(TypedDict):
    hookEventName: Literal["SubagentStart"]
    additionalContext: NotRequired[str]


class PermissionRequestHookSpecificOutput(TypedDict):
    hookEventName: Literal["PermissionRequest"]
    decision: dict[str, Any]


HookSpecificOutput = (
    PreToolUseHookSpecificOutput
    | PostToolUseHookSpecificOutput
    | PostToolUseFailureHookSpecificOutput
    | UserPromptSubmitHookSpecificOutput
    | NotificationHookSpecificOutput
    | SubagentStartHookSpecificOutput
    | PermissionRequestHookSpecificOutput
)
```

#### `AsyncHookJSONOutput`

Async hook output that defers hook execution.

```python theme={null}
class AsyncHookJSONOutput(TypedDict):
    async_: Literal[True]  # Set to True to defer execution
    asyncTimeout: NotRequired[int]  # Timeout in milliseconds
```

<Note>
  Use `async_` (with underscore) in Python code. It is automatically converted to `async` when sent to the CLI.
</Note>

### Hook Usage Example

This example registers two hooks: one that blocks dangerous bash commands like `rm -rf /`, and another that logs all tool usage for auditing. The security hook only runs on Bash commands (via the `matcher`), while the logging hook runs on all tools.

```python theme={null}
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher, HookContext
from typing import Any


async def validate_bash_command(
    input_data: dict[str, Any], tool_use_id: str | None, context: HookContext
) -> dict[str, Any]:
    """Validate and potentially block dangerous bash commands."""
    if input_data["tool_name"] == "Bash":
        command = input_data["tool_input"].get("command", "")
        if "rm -rf /" in command:
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Dangerous command blocked",
                }
            }
    return {}


async def log_tool_use(
    input_data: dict[str, Any], tool_use_id: str | None, context: HookContext
) -> dict[str, Any]:
    """Log all tool usage for auditing."""
    print(f"Tool used: {input_data.get('tool_name')}")
    return {}


options = ClaudeAgentOptions(
    hooks={
        "PreToolUse": [
            HookMatcher(
                matcher="Bash", hooks=[validate_bash_command], timeout=120
            ),  # 2 min for validation
            HookMatcher(
                hooks=[log_tool_use]
            ),  # Applies to all tools (per-event default timeout)
        ],
        "PostToolUse": [HookMatcher(hooks=[log_tool_use])],
    }
)

async def main():
    async for message in query(prompt="Analyze this codebase", options=options):
        print(message)


asyncio.run(main())
```

## Tool Input/Output Types

Documentation of input/output schemas for all built-in Claude Code tools. While the Python SDK doesn't export these as types, they represent the structure of tool inputs and outputs in messages.

### Agent

**Tool name:** `Agent`. The previous name `Task` is still accepted as an alias, and the `tools` list in the init [`SystemMessage`](#systemmessage) reports this tool as `Task` for backward compatibility.

**Input:**

```python theme={null}
{
    "description": str,  # A short (3-5 word) description of the task
    "prompt": str,  # The task for the agent to perform
    "subagent_type": str | None,  # The type of specialized agent to use
    "model": "sonnet" | "opus" | "haiku" | "fable" | None,  # Model override for this agent
    "run_in_background": bool | None,  # Agents run in the background by default; set to False to run synchronously
    "name": str | None,  # Name for the spawned agent
    "team_name": str | None,  # Deprecated; ignored
    "mode": "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan" | None,  # Deprecated; ignored. Subagents inherit the parent session's permission mode; agent-definition frontmatter may override it
    "isolation": "worktree" | "remote" | None,  # Isolation mode for the agent's changes
}
```

Launches a new agent to handle complex, multi-step tasks autonomously.

**Output (status: `"completed"`):**

```python theme={null}
{
    "status": "completed",
    "agentId": str,  # ID of the agent that ran
    "agentType": str | None,  # The subagent type that handled the task
    "content": [  # Result content blocks
        {
            "type": "text",
            "text": str,
            "citations": list | None,
        }
    ],
    "resolvedModel": str | None,  # Model the subagent started on
    "modelsUsed": list[str] | None,  # Models used in order, with consecutive repeats collapsed
    "totalToolUseCount": int,  # Number of tool calls the agent made
    "totalDurationMs": int,  # Execution duration in milliseconds
    "totalTokens": int,  # Token count from the final API request, not the whole run
    "usage": {  # Token usage statistics
        "input_tokens": int,
        "output_tokens": int,
        "cache_creation_input_tokens": int | None,
        "cache_read_input_tokens": int | None,
        "server_tool_use": {"web_search_requests": int, "web_fetch_requests": int} | None,
        "service_tier": str | None,
        "cache_creation": {"ephemeral_1h_input_tokens": int, "ephemeral_5m_input_tokens": int} | None,
        "inference_geo": str | None,
        "speed": str | None,
        "iterations": Any | None,
        "output_tokens_details": {"thinking_tokens": int | None} | None,
    },
    "toolStats": {  # Aggregate tool activity for the run
        "readCount": int,
        "searchCount": int,
        "bashCount": int,
        "editFileCount": int,
        "linesAdded": int,
        "linesRemoved": int,
        "otherToolCount": int,
        "frameCount": int | None,
    } | None,
    "prompt": str,  # The prompt the agent ran
    "worktreePath": str | None,  # Present when Claude Code kept the subagent's worktree
    "worktreeBranch": str | None,  # Present when Claude Code created that worktree with git
}
```

**Output (status: `"async_launched"`):**

```python theme={null}
{
    "status": "async_launched",
    "isAsync": bool | None,  # True on background launches
    "agentId": str,  # ID of the launched agent
    "description": str,  # The task description
    "resolvedModel": str | None,  # Model in use at the backgrounding transition
    "modelsUsed": list[str] | None,  # Models used before backgrounding, in order, with consecutive repeats collapsed
    "prompt": str,  # The prompt the agent runs
    "outputFile": str,  # File path where the agent's output is written
    "canReadOutputFile": bool | None,  # Whether the output file can be read directly
}
```

**Output (status: `"remote_launched"`):**

```python theme={null}
{
    "status": "remote_launched",
    "taskId": str,  # ID of the remote task
    "sessionUrl": str,  # Link to the remote cloud session
    "description": str,  # The task description
    "prompt": str,  # The prompt the agent runs
    "outputFile": str,  # File path where the agent's output is written
}
```

Returns the result from the subagent. The output is discriminated on the `status` field: `"completed"` for finished tasks, `"async_launched"` for background tasks, and `"remote_launched"` for tasks Claude Code dispatched to a remote cloud session, where `sessionUrl` links to that session and `taskId` identifies it. If Claude Code [kept the subagent's isolated worktree](/docs/en/worktrees#isolate-subagents-with-worktrees), `worktreePath` on the `completed` variant is where to find it, and `worktreeBranch` is its branch when Claude Code created the worktree with git.

On the `completed` variant, `resolvedModel` names the model the subagent started on, which can differ from the requested `model` input when [`availableModels`](/docs/en/model-config#restrict-model-selection) or another override applies. This field requires Claude Code v2.1.174 or later. On the `async_launched` variant, `resolvedModel` names the model in use when the agent moved to the background, so a swap that happened before backgrounding is reflected there. The `modelsUsed` field on both variants lists the models used in order, with consecutive repeats collapsed; it's set only when the model was swapped mid-run. `modelsUsed` and the backgrounding-time `resolvedModel` behavior require Claude Code v2.1.212 or later.

Claude Code fills `usage` and `totalTokens` from the subagent's final API request, not from the whole run. When present, `thinking_tokens` under `output_tokens_details` in `usage` is the number of that request's output tokens that were thinking tokens. The `output_tokens_details` key requires Python SDK v0.2.136 or later, which bundles Claude Code v2.1.228.

### AskUserQuestion

**Tool name:** `AskUserQuestion`

Asks the user clarifying questions during execution. See [Handle approvals and user input](/docs/en/agent-sdk/user-input#handle-clarifying-questions) for usage details.

**Input:**

```python theme={null}
{
    "questions": [  # Questions to ask the user (1-4 questions)
        {
            "question": str,  # The complete question to ask the user
            "header": str,  # Very short label displayed as a chip/tag (max 12 chars)
            "options": [  # The available choices (2-4 options)
                {
                    "label": str,  # Display text for this option (1-5 words)
                    "description": str,  # Explanation of what this option means
                    "preview": str | None,  # Preview content rendered when the option is focused
                }
            ],
            "multiSelect": bool,  # Set to true to allow multiple selections
        }
    ],
    "answers": dict[str, str] | None,
    # User answers populated by the permission system. Multi-select
    # answers are a comma-joined string of the selected labels; a
    # list of labels is accepted on input and coerced to that form
    "annotations": dict[str, dict] | None,
    # Per-question annotations from the user, keyed by question text.
    # Each value can carry "preview" (the selected option's preview
    # content) and "notes" (free-text notes on the selection)
    "metadata": dict | None,  # Analytics metadata, such as {"source": "remember"}; not displayed to the user
}
```

**Output:**

```python theme={null}
{
    "questions": [  # The questions that were asked
        {
            "question": str,
            "header": str,
            "options": [{"label": str, "description": str, "preview": str | None}],
            "multiSelect": bool,
        }
    ],
    "answers": dict[str, str],  # Maps question text to answer string
    # Multi-select answers are comma-separated
    "response": str | None,
    # Freeform reply typed instead of answering the questions; when set,
    # Claude receives "The user responded: ..." in place of the answer list
    "annotations": dict[str, dict] | None,  # Per-question "preview" and "notes" from the user's selections
    "afkTimeoutMs": int | None,  # Set when the dialog auto-resolved after this many milliseconds of user inactivity; absent when the user answered
}
```

### Bash

**Tool name:** `Bash`

**Input:**

```python theme={null}
{
    "command": str,  # The command to execute
    "timeout": int | None,  # Optional timeout in milliseconds (max 600000; higher values are clamped to the max)
    "description": str | None,  # Clear, concise description (5-10 words)
    "run_in_background": bool | None,  # Set to true to run in background
}
```

**Output:**

```python theme={null}
{
    "stdout": str,  # The command's output; stdout and stderr arrive merged into this one interleaved stream
    "stderr": str,  # Notices the tool itself adds, not the command's stderr
    "interrupted": bool,  # Whether the command was interrupted
    "isImage": bool | None,  # Whether stdout contains image data
    "backgroundTaskId": str | None,  # ID of the background task if command is running in background
}
```

### Monitor

**Tool name:** `Monitor`

Runs a background source and delivers each event to Claude so it can react without polling: `command` runs a script and emits one event per stdout line, and `ws` opens a WebSocket and emits one event per text frame. Provide exactly one of `command` or `ws`.

When Monitor runs a command, it follows the same permission rules as Bash; a WebSocket watch prompts for approval separately. The `ws` source requires Claude Code v2.1.195 or later. See the [Monitor tool reference](/docs/en/tools-reference#monitor-tool) for behavior and provider availability.

**Input:**

```python theme={null}
{
    "command": str | None,  # Shell script; each stdout line is an event, exit ends the watch
    "ws": dict | None,  # WebSocket source: {"url": str, "protocols": list[str] | None}; each text frame is an event
    "description": str,  # Short description shown in notifications
    "timeout_ms": int | None,  # Kill after this deadline (default 300000, max 3600000)
    "persistent": bool | None,  # Run for the lifetime of the session; stop with TaskStop
}
```

**Output:**

```python theme={null}
{
    "taskId": str,  # ID of the background monitor task
    "timeoutMs": int,  # Timeout deadline in milliseconds (0 when persistent)
    "persistent": bool | None,  # True when running until TaskStop or session end
}
```

### Edit

**Tool name:** `Edit`

**Input:**

```python theme={null}
{
    "file_path": str,  # The absolute path to the file to modify
    "old_string": str,  # The text to replace
    "new_string": str,  # The text to replace it with
    "replace_all": bool | None,  # Replace all occurrences (default False)
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Confirmation message
    "replacements": int,  # Number of replacements made
    "file_path": str,  # File path that was edited
}
```

### Read

**Tool name:** `Read`

**Input:**

```python theme={null}
{
    "file_path": str,  # The absolute path to the file to read
    "offset": int | None,  # The line number to start reading from
    "limit": int | None,  # The number of lines to read
}
```

**Output (Text files):**

```python theme={null}
{
    "content": str,  # File contents with line numbers
    "total_lines": int,  # Total number of lines in file
    "lines_returned": int,  # Lines actually returned
}
```

**Output (Images):**

```python theme={null}
{
    "image": str,  # Base64 encoded image data
    "mime_type": str,  # Image MIME type
    "file_size": int,  # File size in bytes
}
```

### Write

**Tool name:** `Write`

**Input:**

```python theme={null}
{
    "file_path": str,  # The absolute path to the file to write
    "content": str,  # The content to write to the file
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Success message
    "bytes_written": int,  # Number of bytes written
    "file_path": str,  # File path that was written
}
```

### Glob

**Tool name:** `Glob`

**Input:**

```python theme={null}
{
    "pattern": str,  # The glob pattern to match files against
    "path": str | None,  # The directory to search in (defaults to cwd)
}
```

**Output:**

```python theme={null}
{
    "matches": list[str],  # Array of matching file paths
    "count": int,  # Number of matches found
    "search_path": str,  # Search directory used
}
```

### Grep

**Tool name:** `Grep`

**Input:**

```python theme={null}
{
    "pattern": str,  # The regular expression pattern
    "path": str | None,  # File or directory to search in
    "glob": str | None,  # Glob pattern to filter files
    "type": str | None,  # File type to search
    "output_mode": str | None,  # "content", "files_with_matches", or "count"
    "-i": bool | None,  # Case insensitive search
    "-n": bool | None,  # Show line numbers
    "-B": int | None,  # Lines to show before each match
    "-A": int | None,  # Lines to show after each match
    "-C": int | None,  # Lines to show before and after
    "head_limit": int | None,  # Limit output to first N lines/entries
    "multiline": bool | None,  # Enable multiline mode
}
```

**Output (content mode):**

```python theme={null}
{
    "matches": [
        {
            "file": str,
            "line_number": int | None,
            "line": str,
            "before_context": list[str] | None,
            "after_context": list[str] | None,
        }
    ],
    "total_matches": int,
}
```

**Output (files\_with\_matches mode):**

```python theme={null}
{
    "files": list[str],  # Files containing matches
    "count": int,  # Number of files with matches
}
```

### NotebookEdit

**Tool name:** `NotebookEdit`

**Input:**

```python theme={null}
{
    "notebook_path": str,  # Absolute path to the Jupyter notebook
    "cell_id": str | None,  # The ID of the cell to edit
    "new_source": str,  # The new source for the cell
    "cell_type": "code" | "markdown" | None,  # The type of the cell
    "edit_mode": "replace" | "insert" | "delete" | None,  # Edit operation type
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Success message
    "edit_type": "replaced" | "inserted" | "deleted",  # Type of edit performed
    "cell_id": str | None,  # Cell ID that was affected
    "total_cells": int,  # Total cells in notebook after edit
}
```

### WebFetch

**Tool name:** `WebFetch`

**Input:**

```python theme={null}
{
    "url": str,  # The URL to fetch content from
    "prompt": str,  # The prompt to run on the fetched content
}
```

**Output:**

```python theme={null}
{
    "bytes": int,  # Size of the fetched content in bytes
    "code": int,  # HTTP response code
    "codeText": str,  # HTTP response code text
    "result": str,  # Processed result from applying the prompt to the content
    "durationMs": int,  # Time to fetch and process the content, in milliseconds
    "url": str,  # URL that was fetched
}
```

### WebSearch

**Tool name:** `WebSearch`

**Input:**

```python theme={null}
{
    "query": str,  # The search query to use
    "allowed_domains": list[str] | None,  # Only include results from these domains
    "blocked_domains": list[str] | None,  # Never include results from these domains
}
```

**Output:**

```python theme={null}
{
    "query": str,  # The search query
    "results": list[str | {"tool_use_id": str, "content": list[{"title": str, "url": str}]}],
    "durationSeconds": float,  # Search duration in seconds
}
```

### TodoWrite

**Tool name:** `TodoWrite`

<Note>
  On Python Agent SDK 0.2.139 and later, the following restriction applies.

  The following tools aren't available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, or later versions of those families unless you opt in:

  * `TodoWrite`
  * `TaskCreate`
  * `TaskGet`
  * `TaskUpdate`
  * `TaskList`

  On other models, Claude Code provides the Task tools by default and `TodoWrite` only when you set `CLAUDE_CODE_ENABLE_TASKS=0`.

  See [Model availability](/docs/en/agent-sdk/todo-tracking#model-availability) to opt in.
</Note>

**Input:**

```python theme={null}
{
    "todos": [
        {
            "content": str,  # The task description
            "status": "pending" | "in_progress" | "completed",  # Task status
            "activeForm": str,  # Active form of the description
        }
    ]
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Success message
    "stats": {"total": int, "pending": int, "in_progress": int, "completed": int},
}
```

### TaskCreate

**Tool name:** `TaskCreate`

**Input:**

```python theme={null}
{
    "subject": str,  # Short task title
    "description": str,  # Detailed task body
    "activeForm": str | None,  # Present-tense label shown while in progress
    "metadata": dict | None,  # Arbitrary caller metadata
}
```

**Output:**

```python theme={null}
{
    "task": {"id": str, "subject": str},  # Created task with assigned ID
}
```

### TaskUpdate

**Tool name:** `TaskUpdate`

**Input:**

```python theme={null}
{
    "taskId": str,  # ID of the task to patch
    "status": Literal["pending", "in_progress", "completed", "deleted"] | None,
    "subject": str | None,
    "description": str | None,
    "activeForm": str | None,
    "addBlocks": list[str] | None,  # Task IDs this task now blocks
    "addBlockedBy": list[str] | None,  # Task IDs that now block this task
    "owner": str | None,
    "metadata": dict | None,
}
```

**Output:**

```python theme={null}
{
    "success": bool,
    "taskId": str,
    "updatedFields": list[str],  # Names of fields that changed
    "error": str | None,
    "statusChange": {"from": str, "to": str} | None,
}
```

### TaskGet

**Tool name:** `TaskGet`

**Input:**

```python theme={null}
{
    "taskId": str,  # ID of the task to read
}
```

**Output:**

```python theme={null}
{
    "task": {
        "id": str,
        "subject": str,
        "description": str,
        "status": Literal["pending", "in_progress", "completed"],
        "blocks": list[str],
        "blockedBy": list[str],
    } | None,  # None when the ID is not found
}
```

### TaskList

**Tool name:** `TaskList`

**Input:**

```python theme={null}
{}
```

**Output:**

```python theme={null}
{
    "tasks": [
        {
            "id": str,
            "subject": str,
            "status": Literal["pending", "in_progress", "completed"],
            "owner": str | None,
            "blockedBy": list[str],
        }
    ],
}
```

### TaskOutput

**Tool name:** `TaskOutput`. The previous name `BashOutput` is still accepted as an alias.

<Note>`TaskOutput` is deprecated; prefer `Read` on the task's output file path. The schemas below remain valid for hooks and permission handlers that encounter the tool.</Note>

**Input:**

```python theme={null}
{
    "task_id": str,  # The task ID to get output from
    "block": bool,  # Whether to wait for completion (default True)
    "timeout": int,  # Max wait time in ms (default 30000)
}
```

**Output:**

```python theme={null}
{
    "retrieval_status": "success" | "timeout" | "not_ready",  # Whether the output was retrieved
    "task": dict | None,  # Task details: task_id, task_type, status, description, output, plus type-specific fields such as exitCode
}
```

### TaskStop

**Tool name:** `TaskStop`. The previous names `KillShell` and `KillBash` are still accepted as aliases.

**Input:**

```python theme={null}
{
    "task_id": str | None,  # The ID of the background task to stop
    "shell_id": str | None,  # Deprecated: use task_id instead
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Status message about the operation
    "task_id": str,  # The ID of the task that was stopped
    "task_type": str,  # The type of the task that was stopped
    "command": str | None,  # The command or description of the stopped task
}
```

### ExitPlanMode

**Tool name:** `ExitPlanMode`

**Input:**

```python theme={null}
{
    "plan": str  # The plan to run by the user for approval
}
```

**Output:**

```python theme={null}
{
    "message": str,  # Confirmation message
    "approved": bool | None,  # Whether user approved the plan
}
```

### ListMcpResources

**Tool name:** `ListMcpResourcesTool`

**Input:**

```python theme={null}
{
    "server": str | None  # Optional server name to filter resources by
}
```

**Output:**

```python theme={null}
{
    "resources": [
        {
            "uri": str,
            "name": str,
            "description": str | None,
            "mimeType": str | None,
            "server": str,
        }
    ],
    "total": int,
}
```

### ReadMcpResource

**Tool name:** `ReadMcpResourceTool`

**Input:**

```python theme={null}
{
    "server": str,  # The MCP server name
    "uri": str,  # The resource URI to read
}
```

**Output:**

```python theme={null}
{
    "contents": [
        {"uri": str, "mimeType": str | None, "text": str | None, "blob": str | None}
    ],
    "server": str,
}
```

## Build a continuous conversation interface

The following example keeps one `ClaudeSDKClient` connected across turns, so Claude remembers earlier messages. Type `new` to disconnect and reconnect for a fresh session, or `exit` to end the conversation.

```python theme={null}
from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
)
import asyncio


class ConversationSession:
    """Maintains a single conversation session with Claude."""

    def __init__(self, options: ClaudeAgentOptions | None = None):
        self.client = ClaudeSDKClient(options)
        self.turn_count = 0

    async def start(self):
        await self.client.connect()
        print("Starting conversation session. Claude will remember context.")
        print(
            "Commands: 'exit' to quit, 'interrupt' to stop current task, 'new' for new session"
        )

        while True:
            user_input = input(f"\n[Turn {self.turn_count + 1}] You: ")

            if user_input.lower() == "exit":
                break
            elif user_input.lower() == "interrupt":
                await self.client.interrupt()
                print("Task interrupted!")
                continue
            elif user_input.lower() == "new":
                # Disconnect and reconnect for a fresh session
                await self.client.disconnect()
                await self.client.connect()
                self.turn_count = 0
                print("Started new conversation session (previous context cleared)")
                continue

            # Send message - the session retains all previous messages
            await self.client.query(user_input)
            self.turn_count += 1

            # Process response
            print(f"[Turn {self.turn_count}] Claude: ", end="")
            async for message in self.client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            print(block.text, end="")
            print()  # New line after response

        await self.client.disconnect()
        print(f"Conversation ended after {self.turn_count} turns.")


async def main():
    options = ClaudeAgentOptions(
        allowed_tools=["Read", "Write", "Bash"], permission_mode="acceptEdits"
    )
    session = ConversationSession(options)
    await session.start()


# Example conversation:
# Turn 1 - You: "Create a file called hello.py"
# Turn 1 - Claude: "I'll create a hello.py file for you..."
# Turn 2 - You: "What's in that file?"
# Turn 2 - Claude: "The hello.py file I just created contains..." (remembers!)
# Turn 3 - You: "Add a main function to it"
# Turn 3 - Claude: "I'll add a main function to hello.py..." (knows which file!)

asyncio.run(main())
```

## Error handling

The following example wraps a `query()` call in handlers for four of the [error types](#error-types) the SDK raises.

This example catches [`ResultError`](#resulterror), which requires Python Agent SDK 0.2.140 or later.

```python theme={null}
import asyncio

from claude_agent_sdk import (
    query,
    CLINotFoundError,
    ProcessError,
    ResultError,
    CLIJSONDecodeError,
)


async def main():
    try:
        async for message in query(prompt="Hello"):
            print(message)
    except CLINotFoundError:
        print(
            "Claude Code CLI not found. Try reinstalling: pip install --force-reinstall claude-agent-sdk"
        )
    # Catch ResultError before ProcessError, which it subclasses. Its message
    # carries the error text. A failed final request, such as an API error,
    # arrives with subtype "success", so branch on terminal_reason first.
    except ResultError as e:
        if e.terminal_reason == "api_error":
            print(f"API request failed: {e}")
        else:
            print(f"Query ended with an error result ({e.terminal_reason or e.subtype}): {e}")
    except ProcessError as e:
        print(f"Process failed with exit code: {e.exit_code}")
    except CLIJSONDecodeError as e:
        print(f"Failed to parse response: {e}")


asyncio.run(main())
```

## Sandbox Configuration

### `SandboxSettings`

Configuration for sandbox behavior. Use this to enable command sandboxing and configure network restrictions programmatically.

```python theme={null}
class SandboxSettings(TypedDict, total=False):
    enabled: bool
    autoAllowBashIfSandboxed: bool
    excludedCommands: list[str]
    allowUnsandboxedCommands: bool
    network: SandboxNetworkConfig
    ignoreViolations: SandboxIgnoreViolations
    enableWeakerNestedSandbox: bool
```

| Property                    | Type                                                  | Default | Description                                                                                                                                                                                                                             |
| :-------------------------- | :---------------------------------------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `bool`                                                | `False` | Enable sandbox mode for command execution                                                                                                                                                                                               |
| `autoAllowBashIfSandboxed`  | `bool`                                                | `True`  | Auto-approve bash commands when sandbox is enabled                                                                                                                                                                                      |
| `excludedCommands`          | `list[str]`                                           | `[]`    | Commands that always bypass sandbox restrictions (e.g., `["docker"]`). These run unsandboxed automatically without model involvement                                                                                                    |
| `allowUnsandboxedCommands`  | `bool`                                                | `True`  | Allow the model to request running commands outside the sandbox. When `True`, the model can set `dangerouslyDisableSandbox` in tool input, which falls back to the [permissions system](#permissions-fallback-for-unsandboxed-commands) |
| `network`                   | [`SandboxNetworkConfig`](#sandboxnetworkconfig)       | `None`  | Network-specific sandbox configuration                                                                                                                                                                                                  |
| `ignoreViolations`          | [`SandboxIgnoreViolations`](#sandboxignoreviolations) | `None`  | Configure which sandbox violations to ignore                                                                                                                                                                                            |
| `enableWeakerNestedSandbox` | `bool`                                                | `False` | Enable a weaker nested sandbox for compatibility                                                                                                                                                                                        |

<Note>
  The sandbox depends on platform support and, on Linux, tools like `bubblewrap` and `socat`. By default, when `enabled` is `True` but the sandbox can't start, commands run unsandboxed with a warning on stderr. This default differs from the TypeScript SDK, where `failIfUnavailable` defaults to `true`.

  Set `"failIfUnavailable": True` in your sandbox settings to stop instead. The key isn't declared on `SandboxSettings` yet, but the SDK forwards it to Claude Code, which honors it. `query()` then reports a `ResultMessage` with `subtype="error_during_execution"` and the reason in `errors`. Because this is a single-shot `query()` call, the SDK raises after yielding that error result, so wrap the loop in a try block to continue past it. See [Handle the result](/docs/en/agent-sdk/agent-loop#handle-the-result) for the error contract.
</Note>

#### Example usage

```python theme={null}
import asyncio

from claude_agent_sdk import query, ClaudeAgentOptions

sandbox_settings = {
    "enabled": True,
    "autoAllowBashIfSandboxed": True,
    "failIfUnavailable": True,
    "network": {"allowLocalBinding": True},
}


async def main():
    try:
        async for message in query(
            prompt="Build and test my project",
            options=ClaudeAgentOptions(sandbox=sandbox_settings),
        ):
            print(message)
    except Exception as error:
        # A single-shot query() raises after yielding an error result,
        # such as when failIfUnavailable is set and the sandbox can't start.
        print(f"Session ended with an error: {error}")


asyncio.run(main())
```

<Warning>
  **Unix socket security**: The `allowUnixSockets` option can grant access to system services that reach outside the sandbox. For example, allowing `/var/run/docker.sock` effectively grants full host system access through the Docker API, bypassing sandbox isolation. Only allow Unix sockets that are strictly necessary and understand the security implications of each.
</Warning>

### `SandboxNetworkConfig`

Network-specific configuration for sandbox mode. These settings apply to sandboxed Bash commands when `enabled` is `True` in the parent [`SandboxSettings`](#sandboxsettings). They do not restrict the WebFetch tool, which uses [permission rules](/docs/en/permissions#webfetch) instead.

```python theme={null}
class SandboxNetworkConfig(TypedDict, total=False):
    allowedDomains: list[str]
    deniedDomains: list[str]
    allowManagedDomainsOnly: bool
    allowUnixSockets: list[str]
    allowAllUnixSockets: bool
    allowLocalBinding: bool
    allowMachLookup: list[str]
    httpProxyPort: int
    socksProxyPort: int
```

| Property                  | Type        | Default | Description                                                                                                                                                                                   |
| :------------------------ | :---------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedDomains`          | `list[str]` | `[]`    | Domain names that sandboxed processes can access                                                                                                                                              |
| `deniedDomains`           | `list[str]` | `[]`    | Domain names that sandboxed processes cannot access. Takes precedence over `allowedDomains`                                                                                                   |
| `allowManagedDomainsOnly` | `bool`      | `False` | Managed-settings only: when set in managed settings, ignore `allowedDomains` and `WebFetch(domain:...)` allow rules from non-managed settings sources. Has no effect when set via SDK options |
| `allowUnixSockets`        | `list[str]` | `[]`    | Unix socket paths that processes can access (e.g., Docker socket)                                                                                                                             |
| `allowAllUnixSockets`     | `bool`      | `False` | Allow access to all Unix sockets                                                                                                                                                              |
| `allowLocalBinding`       | `bool`      | `False` | Allow processes to bind to local ports (e.g., for dev servers)                                                                                                                                |
| `allowMachLookup`         | `list[str]` | `[]`    | macOS only: XPC/Mach service names to allow. Supports a trailing wildcard                                                                                                                     |
| `httpProxyPort`           | `int`       | `None`  | HTTP proxy port for network requests                                                                                                                                                          |
| `socksProxyPort`          | `int`       | `None`  | SOCKS proxy port for network requests                                                                                                                                                         |

<Note>
  The built-in sandbox proxy enforces the network allowlist based on the requested hostname and does not terminate or inspect TLS traffic, so techniques such as [domain fronting](https://en.wikipedia.org/wiki/Domain_fronting) can potentially bypass it. See [Sandboxing security limitations](/docs/en/sandboxing#security-limitations) for details and [Secure deployment](/docs/en/agent-sdk/secure-deployment#traffic-forwarding) for configuring a TLS-terminating proxy.
</Note>

### `SandboxIgnoreViolations`

Configuration for ignoring specific sandbox violations.

```python theme={null}
class SandboxIgnoreViolations(TypedDict, total=False):
    file: list[str]
    network: list[str]
```

| Property  | Type        | Default | Description                                 |
| :-------- | :---------- | :------ | :------------------------------------------ |
| `file`    | `list[str]` | `[]`    | File path patterns to ignore violations for |
| `network` | `list[str]` | `[]`    | Network patterns to ignore violations for   |

### Permissions Fallback for Unsandboxed Commands

When `allowUnsandboxedCommands` is enabled, the model can request to run commands outside the sandbox by setting `dangerouslyDisableSandbox: True` in the tool input. These requests fall back to the existing permissions system, meaning your `can_use_tool` handler will be invoked, allowing you to implement custom authorization logic. Commands listed in `excludedCommands` instead bypass the sandbox automatically, with no model involvement; see [`SandboxSettings`](#sandboxsettings).

The following example logs each unsandboxed request and denies it unless your own authorization logic allows it:

```python theme={null}
import asyncio
from claude_agent_sdk import (
    query,
    ClaudeAgentOptions,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
)


def is_command_authorized(command: str | None) -> bool:
    # Replace with your own authorization logic
    return False



async def can_use_tool(
    tool: str, input: dict, context: ToolPermissionContext
) -> PermissionResultAllow | PermissionResultDeny:
    # Check if the model is requesting to bypass the sandbox
    if tool == "Bash" and input.get("dangerouslyDisableSandbox"):
        # The model is requesting to run this command outside the sandbox
        print(f"Unsandboxed command requested: {input.get('command')}")

        if is_command_authorized(input.get("command")):
            return PermissionResultAllow()
        return PermissionResultDeny(
            message="Command not authorized for unsandboxed execution"
        )
    return PermissionResultAllow()


# Required: dummy hook keeps the stream open for can_use_tool
async def dummy_hook(input_data, tool_use_id, context):
    return {"continue_": True}


async def prompt_stream():
    yield {
        "type": "user",
        "message": {"role": "user", "content": "Deploy my application"},
    }


async def main():
    async for message in query(
        prompt=prompt_stream(),
        options=ClaudeAgentOptions(
            sandbox={
                "enabled": True,
                "allowUnsandboxedCommands": True,  # Model can request unsandboxed execution
            },
            permission_mode="default",
            can_use_tool=can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[dummy_hook])]},
        ),
    ):
        print(message)


asyncio.run(main())
```

<Warning>
  Commands running with `dangerouslyDisableSandbox: True` have full system access. Ensure your `can_use_tool` handler validates these requests carefully.

  If `permission_mode` is set to `bypassPermissions` and `allow_unsandboxed_commands` is enabled, the model can autonomously execute commands outside the sandbox without approval prompts, apart from the [actions no mode auto-approves](/docs/en/permission-modes#actions-no-mode-auto-approves). This combination effectively allows the model to escape sandbox isolation silently.
</Warning>

## See also

* [SDK overview](/docs/en/agent-sdk/overview) - General SDK concepts
* [TypeScript SDK reference](/docs/en/agent-sdk/typescript) - TypeScript SDK documentation
* [Custom tools](/docs/en/agent-sdk/custom-tools) - Define in-process MCP tools for Claude to call
* [CLI reference](/docs/en/cli-reference) - Command-line interface
* [Common workflows](/docs/en/common-workflows) - Step-by-step guides
