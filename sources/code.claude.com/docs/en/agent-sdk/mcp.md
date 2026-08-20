> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Connect to external tools with MCP

> Configure MCP servers to extend your agent with external tools. Covers transport types, tool search for large tool sets, authentication, and error handling.

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro) is an open standard for connecting AI agents to external tools and data sources. With MCP, your agent can query databases, integrate with APIs like Slack and GitHub, and connect to other services without writing custom tool implementations.

MCP servers can run as local processes, connect over HTTP, or execute directly within your SDK application.

<Note>
  This page covers MCP configuration for the Agent SDK. To add MCP servers to the Claude Code CLI so they load in every project, see [MCP installation scopes](/docs/en/mcp#mcp-installation-scopes).
</Note>

## Quickstart

This example connects to the [Claude Code documentation](https://code.claude.com/docs) MCP server using [HTTP transport](#http%2Fsse-servers) and uses [`allowedTools`](#allow-mcp-tools) with a wildcard to permit all tools from the server.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "Use the docs MCP server to explain what hooks are in Claude Code",
    options: {
      mcpServers: {
        "claude-code-docs": {
          type: "http",
          url: "https://code.claude.com/docs/mcp"
        }
      },
      allowedTools: ["mcp__claude-code-docs__*"]
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "claude-code-docs": {
                  "type": "http",
                  "url": "https://code.claude.com/docs/mcp",
              }
          },
          allowed_tools=["mcp__claude-code-docs__*"],
      )

      async for message in query(
          prompt="Use the docs MCP server to explain what hooks are in Claude Code",
          options=options,
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

The agent connects to the documentation server, searches for information about hooks, and returns the results.

## Add an MCP server

You can configure MCP servers in code when calling `query()`, or in a `.mcp.json` file loaded via [`settingSources`](#from-a-config-file).

### In code

Pass MCP servers directly in the `mcpServers` option:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "List files in my project",
    options: {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
        }
      },
      allowedTools: ["mcp__filesystem__*"]
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "filesystem": {
                  "command": "npx",
                  "args": [
                      "-y",
                      "@modelcontextprotocol/server-filesystem",
                      "/Users/me/projects",
                  ],
              }
          },
          allowed_tools=["mcp__filesystem__*"],
      )

      async for message in query(prompt="List files in my project", options=options):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

### From a config file

Create a `.mcp.json` file at your project root. The file is picked up when the `project` setting source is enabled, which it is for default `query()` options. If you set `settingSources` explicitly, include `"project"` for this file to load:

```json theme={null}
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    }
  }
}
```

## Connection timing

Claude Code registers the servers you pass in `options.mcpServers` at startup and emits the [init message](#error-handling) once the first-turn wait, if any, resolves. Servers loaded from [settings files](#from-a-config-file) such as `.mcp.json` don't get the full wait and commonly show `pending` at init. When each `options.mcpServers` server connects, and whether it delays the first turn, depends on its type:

| Server type                                                                            | Delays the first turn?                                 | First-turn wait timeout                                                                     |
| :------------------------------------------------------------------------------------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| stdio server, or HTTP/SSE server without a cached tool list                            | Yes, until it connects                                 | [`MCP_TIMEOUT`](/docs/en/env-vars), 30 seconds by default; the connection fails at that deadline |
| Remote server with a cached tool list, saved by Claude Code from a previous connection | No; the cached tools are available from the first turn | None; connects on its first tool call, and that deferred connect has its own timeout        |
| In-process [SDK server](#sdk-mcp-servers)                                              | No; never delays the first turn                        | None                                                                                        |

To block startup itself at a separate, earlier phase than the first-turn wait, before the init message is sent:

* Set [`MCP_CONNECTION_NONBLOCKING`](/docs/en/env-vars) to `0` to block on the whole connection batch. Claude Code caps that wait at 5 seconds by default. Adjust the cap with the [`MCP_CONNECT_TIMEOUT_MS`](/docs/en/env-vars) environment variable, in milliseconds. Servers still pending at that deadline keep connecting in the background.
* Set `alwaysLoad: true` on a server's config to make its tools available at their full schemas on the first turn, [exempt from tool search deferral](/docs/en/mcp#exempt-a-server-from-deferral). Claude Code waits at startup for that server's tools, capped at the same deadline, while other servers keep connecting in the background; a remote server with a cached tool list supplies them without connecting, per the table above.

The `system` message with subtype `init` reports each server's status at the moment it's emitted; see [Error handling](#error-handling) for reading those statuses.

## Allow MCP tools

MCP tools require explicit permission before Claude can use them. Without permission, Claude will see that tools are available but won't be able to call them.

### Tool naming convention

MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>`. For example, a GitHub server named `"github"` with a `list_issues` tool becomes `mcp__github__list_issues`.

### Auto-approve with allowedTools

Use `allowedTools` to auto-approve specific MCP tools so Claude can use them without a permission prompt:

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        // your servers
      },
      allowedTools: [
        "mcp__github__*", // All tools from the github server
        "mcp__db__query", // Only the query tool from db server
        "mcp__slack__send_message" // Only send_message from slack server
      ]
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          # your servers
      },
      allowed_tools=[
          "mcp__github__*",  # All tools from the github server
          "mcp__db__query",  # Only the query tool from db server
          "mcp__slack__send_message",  # Only send_message from slack server
      ],
  )
  ```
</CodeGroup>

Wildcards (`*`) let you allow all tools from a server without listing each one individually.

<Note>
  **Prefer `allowedTools` over permission modes for MCP access.** `permissionMode: "acceptEdits"` does not auto-approve MCP tools (only file edits and filesystem Bash commands). `permissionMode: "bypassPermissions"` does auto-approve MCP tools but also disables most other safety prompts, which is broader than necessary; see [How permissions are evaluated](/docs/en/agent-sdk/permissions#how-permissions-are-evaluated) for the prompts that remain. A wildcard in `allowedTools` grants exactly the MCP server you want and nothing more. See [Permission modes](/docs/en/agent-sdk/permissions#permission-modes) for a full comparison.
</Note>

### Discover available tools

To see what tools an MCP server provides, check the server's documentation or inspect the `tools` array in the `system` init message. MCP tool names start with `mcp__`.

Claude Code emits the init message after the [first-turn connection wait](#connection-timing) for servers passed in `options.mcpServers`, so the `tools` array lists the `mcp__` tools of each server that has connected by then, plus those of servers with a [cached tool list](#connection-timing), which connect on first use. Tools of any other server that hasn't connected are absent; see [Error handling](#error-handling) for reading each server's status.

This filter prints the MCP tool names:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  const options = {
    mcpServers: {
      // your servers
    },
  };

  for await (const message of query({ prompt: "...", options })) {
    if (message.type === "system" && message.subtype === "init") {
      const mcpTools = message.tools.filter((name) => name.startsWith("mcp__"));
      console.log("Available MCP tools:", mcpTools);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              # your servers
          },
      )
      async for message in query(prompt="...", options=options):
          if isinstance(message, SystemMessage) and message.subtype == "init":
              mcp_tools = [t for t in message.data.get("tools", []) if t.startswith("mcp__")]
              print("Available MCP tools:", mcp_tools)


  asyncio.run(main())
  ```
</CodeGroup>

You can also ask Claude to list the tools available from a server.

## Transport types

MCP servers communicate with your agent using different transport protocols. Check the server's documentation to see which transport it supports:

* If the docs give you a **command to run** (like `npx @modelcontextprotocol/server-filesystem`), use stdio
* If the docs give you a **URL**, use HTTP or SSE
* If you're building your own tools in code, use an SDK MCP server

### stdio servers

Local processes that communicate via stdin/stdout. Use this for MCP servers you run on the same machine. For the `.mcp.json` form, use the same fields shown at [From a config file](#from-a-config-file). In code, pass the command and its arguments:

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
        }
      },
      allowedTools: ["mcp__filesystem__read_file", "mcp__filesystem__list_directory"]
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          "filesystem": {
              "command": "npx",
              "args": [
                  "-y",
                  "@modelcontextprotocol/server-filesystem",
                  "/Users/me/projects",
              ],
          }
      },
      allowed_tools=["mcp__filesystem__read_file", "mcp__filesystem__list_directory"],
  )
  ```
</CodeGroup>

### HTTP/SSE servers

Use HTTP or SSE for cloud-hosted MCP servers and remote APIs:

<Tabs>
  <Tab title="In code">
    <CodeGroup>
      ```typescript TypeScript hidelines={1,-1} theme={null}
      const _ = {
        options: {
          mcpServers: {
            "remote-api": {
              type: "sse",
              url: "https://api.example.com/mcp/sse",
              headers: {
                Authorization: `Bearer ${process.env.API_TOKEN}`
              }
            }
          },
          allowedTools: ["mcp__remote-api__*"]
        }
      };
      ```

      ```python Python theme={null}
      options = ClaudeAgentOptions(
          mcp_servers={
              "remote-api": {
                  "type": "sse",
                  "url": "https://api.example.com/mcp/sse",
                  "headers": {"Authorization": f"Bearer {os.environ['API_TOKEN']}"},
              }
          },
          allowed_tools=["mcp__remote-api__*"],
      )
      ```
    </CodeGroup>
  </Tab>

  <Tab title=".mcp.json">
    ```json theme={null}
    {
      "mcpServers": {
        "remote-api": {
          "type": "sse",
          "url": "https://api.example.com/mcp/sse",
          "headers": {
            "Authorization": "Bearer ${API_TOKEN}"
          }
        }
      }
    }
    ```
  </Tab>
</Tabs>

For the streamable HTTP transport, use `"type": "http"` instead. In `.mcp.json` and other JSON config files, `"streamable-http"` is accepted as an alias for `"http"`. The programmatic `mcpServers` option accepts only `"http"`.

### SDK MCP servers

Define custom tools directly in your application code instead of running a separate server process. See the [custom tools guide](/docs/en/agent-sdk/custom-tools) for implementation details.

An SDK MCP server registered by an [`initialize` control request](/docs/en/agent-sdk/typescript#sdkcontrolinitializeresponse) begins connecting as soon as Claude Code processes the request.

## MCP tool search

When you have many MCP tools configured, tool definitions can consume a significant portion of your context window. Tool search solves this by withholding tool definitions from context and loading only the ones Claude needs for each turn.

Tool search is enabled by default. See [Tool search](/docs/en/agent-sdk/tool-search) for configuration options, best practices, and using tool search with custom SDK tools.

## Authentication

Most MCP servers require authentication to access external services. Pass credentials through environment variables in the server configuration.

### Pass credentials via environment variables

Use the `env` field to pass API keys, tokens, and other credentials to the MCP server:

<Tabs>
  <Tab title="In code">
    <CodeGroup>
      ```typescript TypeScript hidelines={1,-1} theme={null}
      const _ = {
        options: {
          mcpServers: {
            "api-server": {
              command: "npx",
              args: ["-y", "@your-org/api-mcp-server"],
              env: {
                API_KEY: process.env.API_KEY
              }
            }
          },
          allowedTools: ["mcp__api-server__*"]
        }
      };
      ```

      ```python Python theme={null}
      options = ClaudeAgentOptions(
          mcp_servers={
              "api-server": {
                  "command": "npx",
                  "args": ["-y", "@your-org/api-mcp-server"],
                  "env": {"API_KEY": os.environ["API_KEY"]},
              }
          },
          allowed_tools=["mcp__api-server__*"],
      )
      ```
    </CodeGroup>
  </Tab>

  <Tab title=".mcp.json">
    ```json theme={null}
    {
      "mcpServers": {
        "api-server": {
          "command": "npx",
          "args": ["-y", "@your-org/api-mcp-server"],
          "env": {
            "API_KEY": "${API_KEY}"
          }
        }
      }
    }
    ```

    The `${API_KEY}` syntax expands environment variables at runtime.
  </Tab>
</Tabs>

### HTTP headers for remote servers

For HTTP and SSE servers, pass authentication headers directly in the server configuration:

<Tabs>
  <Tab title="In code">
    <CodeGroup>
      ```typescript TypeScript hidelines={1,-1} theme={null}
      const _ = {
        options: {
          mcpServers: {
            "secure-api": {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: {
                Authorization: `Bearer ${process.env.API_TOKEN}`
              }
            }
          },
          allowedTools: ["mcp__secure-api__*"]
        }
      };
      ```

      ```python Python theme={null}
      options = ClaudeAgentOptions(
          mcp_servers={
              "secure-api": {
                  "type": "http",
                  "url": "https://api.example.com/mcp",
                  "headers": {"Authorization": f"Bearer {os.environ['API_TOKEN']}"},
              }
          },
          allowed_tools=["mcp__secure-api__*"],
      )
      ```
    </CodeGroup>
  </Tab>

  <Tab title=".mcp.json">
    ```json theme={null}
    {
      "mcpServers": {
        "secure-api": {
          "type": "http",
          "url": "https://api.example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${API_TOKEN}"
          }
        }
      }
    }
    ```

    The `${API_TOKEN}` syntax expands environment variables at runtime.
  </Tab>
</Tabs>

For a complete working example of a remote server authenticated with headers, see [List issues from a repository](#list-issues-from-a-repository).

### OAuth2 authentication

The [MCP specification supports OAuth 2.1](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization) for authorization. The SDK doesn't open a browser or run an interactive OAuth flow. When a configured server returns an authorization challenge and no stored token is available, the agent run continues without that server's tools, and the server reports status `needs-auth`. The `mcp_servers` array of the [system init message](/docs/en/agent-sdk/typescript#sdksystemmessage) may still show `pending` for that server when it's emitted. To confirm whether a server needs credentials, poll `mcpServerStatus()` in the TypeScript SDK or [`get_mcp_status()`](/docs/en/agent-sdk/python#methods) in Python.

To supply credentials, complete the OAuth flow in your own application and pass the resulting access token in the server's `headers`:

<CodeGroup>
  ```typescript TypeScript theme={null}
  // After completing OAuth flow in your app.
  // Implement getAccessTokenFromOAuthFlow for your OAuth provider.
  const accessToken = await getAccessTokenFromOAuthFlow();

  const options = {
    mcpServers: {
      "oauth-api": {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    },
    allowedTools: ["mcp__oauth-api__*"]
  };
  ```

  ```python Python theme={null}
  # After completing OAuth flow in your app.
  # Implement get_access_token_from_oauth_flow for your OAuth provider.
  access_token = await get_access_token_from_oauth_flow()

  options = ClaudeAgentOptions(
      mcp_servers={
          "oauth-api": {
              "type": "http",
              "url": "https://api.example.com/mcp",
              "headers": {"Authorization": f"Bearer {access_token}"},
          }
      },
      allowed_tools=["mcp__oauth-api__*"],
  )
  ```
</CodeGroup>

## Examples

### List issues from a repository

This example connects to the remote [GitHub MCP server](https://github.com/github/github-mcp-server) to list recent issues. The example includes debug logging to verify the MCP connection and tool calls.

Before running, create a [GitHub personal access token](https://github.com/settings/personal-access-tokens) with read access to the repositories you want to query and set it as an environment variable:

```bash theme={null}
export GITHUB_TOKEN=YOUR_GITHUB_PAT
```

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    prompt: "List the 3 most recent issues in anthropics/claude-code",
    options: {
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
          }
        }
      },
      allowedTools: ["mcp__github__list_issues"]
    }
  })) {
    // Verify MCP server connected successfully
    if (message.type === "system" && message.subtype === "init") {
      console.log("MCP servers:", message.mcp_servers);
    }

    // Log when Claude calls an MCP tool
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name.startsWith("mcp__")) {
          console.log("MCP tool called:", block.name);
        }
      }
    }

    // Print the final result
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  import os
  from claude_agent_sdk import (
      query,
      ClaudeAgentOptions,
      ResultMessage,
      SystemMessage,
      AssistantMessage,
  )


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "github": {
                  "type": "http",
                  "url": "https://api.githubcopilot.com/mcp/",
                  "headers": {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"},
              }
          },
          allowed_tools=["mcp__github__list_issues"],
      )

      async for message in query(
          prompt="List the 3 most recent issues in anthropics/claude-code",
          options=options,
      ):
          # Verify MCP server connected successfully
          if isinstance(message, SystemMessage) and message.subtype == "init":
              print("MCP servers:", message.data.get("mcp_servers"))

          # Log when Claude calls an MCP tool
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if hasattr(block, "name") and block.name.startswith("mcp__"):
                      print("MCP tool called:", block.name)

          # Print the final result
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

### Query a database

This example uses [DBHub](https://github.com/bytebase/dbhub) to query a Postgres database. The agent automatically discovers the database schema, writes the SQL query, and returns the results.

DBHub's `execute_sql` tool runs whatever SQL the agent emits, including writes, unless you restrict it. Setting `readonly = true` in the [DBHub configuration file](https://dbhub.ai/config/toml) makes DBHub reject `INSERT`, `UPDATE`, `DELETE`, and DDL statements, so the example cannot modify your data even if the agent emits a write. DBHub resolves `${DATABASE_URL}` from the process environment when it loads the config, so the connection string stays out of the file. Create this `dbhub.toml` next to your script:

```toml dbhub.toml theme={null}
[[sources]]
id = "production"
dsn = "${DATABASE_URL}"

[[tools]]
name = "execute_sql"
source = "production"
readonly = true
```

The script then points DBHub at the config file instead of passing a connection string directly. Before running, set the `DATABASE_URL` environment variable to your connection string. Replace the placeholder values with your own database details:

```bash theme={null}
export DATABASE_URL=postgresql://user:password@localhost:5432/mydb
```

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  for await (const message of query({
    // Natural language query - Claude writes the SQL
    prompt: "How many users signed up last week? Break it down by day.",
    options: {
      mcpServers: {
        postgres: {
          command: "npx",
          // dbhub.toml sets readonly = true, so execute_sql rejects writes
          args: ["-y", "@bytebase/dbhub", "--config", "dbhub.toml"]
        }
      },
      allowedTools: ["mcp__postgres__execute_sql"]
    }
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "postgres": {
                  "command": "npx",
                  # dbhub.toml sets readonly = true, so execute_sql rejects writes
                  "args": [
                      "-y",
                      "@bytebase/dbhub",
                      "--config",
                      "dbhub.toml",
                  ],
              }
          },
          allowed_tools=["mcp__postgres__execute_sql"],
      )

      # Natural language query - Claude writes the SQL
      async for message in query(
          prompt="How many users signed up last week? Break it down by day.",
          options=options,
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

## Error handling

MCP servers can fail to connect for various reasons: the server process might not be installed, credentials might be invalid, or a remote server might be unreachable.

Claude Code emits a `system` message with subtype `init` at the start of each query. This message includes the connection status for each MCP server. The `status` field can be `"pending"`, `"connected"`, `"failed"`, `"needs-auth"`, or `"disabled"`. Claude Code emits the init message after the [first-turn connection wait](#connection-timing) for servers passed in `options.mcpServers`, so such a server that connected within the wait shows `"connected"`. A `"pending"` status means the server hasn't connected yet, which is common for [settings-file servers](#from-a-config-file) that don't get the full wait, or that its tool list was [served from the cache](#connection-timing) with a connection made on first use; the reported status for a deadline-expired server can be `"pending"` or `"failed"` depending on timing. Don't treat `"pending"` as a failure. Check for `"failed"` or `"needs-auth"` to detect servers that won't be usable:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  try {
    for await (const message of query({
      prompt: "Process data",
      options: {
        mcpServers: {
          // Replace dataServer with your server configuration
          "data-processor": dataServer
        }
      }
    })) {
      if (message.type === "system" && message.subtype === "init") {
        const unavailableServers = message.mcp_servers.filter(
          (s) => s.status === "failed" || s.status === "needs-auth"
        );

        if (unavailableServers.length > 0) {
          console.warn("Unavailable MCP servers:", unavailableServers);
        }
      }

      if (message.type === "result" && message.subtype === "error_during_execution") {
        console.error("Execution failed");
      }
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result. If the
    // failure was an error result, the error subtype branch above has
    // already run; a failure to start or reach the Claude Code process
    // yields no result message. MCP servers that fail to connect don't
    // throw: use the status check above, and note that servers still
    // "pending" at init need a later status check.
    console.log(`Session ended with an error: ${error}`);
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage, ResultMessage


  async def main():
      # Replace data_server with your server configuration
      options = ClaudeAgentOptions(mcp_servers={"data-processor": data_server})

      try:
          async for message in query(prompt="Process data", options=options):
              if isinstance(message, SystemMessage) and message.subtype == "init":
                  unavailable_servers = [
                      s
                      for s in message.data.get("mcp_servers", [])
                      if s.get("status") in ("failed", "needs-auth")
                  ]

                  if unavailable_servers:
                      print(f"Unavailable MCP servers: {unavailable_servers}")

              if (
                  isinstance(message, ResultMessage)
                  and message.subtype == "error_during_execution"
              ):
                  print("Execution failed")
      except Exception as error:
          # A single-shot query() raises after yielding an error result. If the
          # failure was an error result, the error subtype branch above has
          # already run; a failure to start or reach the Claude Code process
          # yields no result message. MCP servers that fail to connect don't
          # raise: use the status check above, and note that servers still
          # "pending" at init need a later status check.
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```
</CodeGroup>

## Troubleshooting

### Server shows "failed" status

Check the `init` message to see which servers failed to connect:

<CodeGroup>
  ```typescript TypeScript theme={null}
  if (message.type === "system" && message.subtype === "init") {
    for (const server of message.mcp_servers) {
      if (server.status === "failed") {
        console.error(`Server ${server.name} failed to connect`);
      }
    }
  }
  ```

  ```python Python theme={null}
  if isinstance(message, SystemMessage) and message.subtype == "init":
      for server in message.data.get("mcp_servers", []):
          if server.get("status") == "failed":
              print(f"Server {server['name']} failed to connect")
  ```
</CodeGroup>

A `"pending"` status doesn't mean the server failed; see [Error handling](#error-handling) for the two cases it covers at init. To get updated statuses later in the session, call the query's `mcpServerStatus()` method in the TypeScript SDK, or [`ClaudeSDKClient.get_mcp_status()`](/docs/en/agent-sdk/python#methods) in Python.

Common causes:

* **Missing environment variables**: Ensure required tokens and credentials are set. For stdio servers, check the `env` field matches what the server expects.
* **Server not installed**: For `npx` commands, verify the package exists and Node.js is in your PATH.
* **Invalid connection string**: For database servers, verify the connection string format and that the database is accessible.
* **Network issues**: For remote HTTP/SSE servers, check the URL is reachable and any firewalls allow the connection.

### Tools not being called

If Claude sees tools but doesn't use them, check that you've granted permission with `allowedTools`:

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        // your servers
      },
      allowedTools: ["mcp__servername__*"] // Auto-approve calls from this server
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          # your servers
      },
      allowed_tools=["mcp__servername__*"],  # Auto-approve calls from this server
  )
  ```
</CodeGroup>

### Connection timeouts

MCP server connections time out after 30 seconds by default. Claude Code applies that limit to the connection attempt only; to change how long a running tool call may take, set [`MCP_TOOL_TIMEOUT`](/docs/en/env-vars). If your server takes longer to start, the connection fails. Raise the connection limit with the [`MCP_TIMEOUT`](/docs/en/env-vars) environment variable, in milliseconds. For servers that need more startup time, also consider:

* Using a lighter-weight server if available
* Pre-warming the server before starting your agent
* Checking server logs for slow initialization causes

### Tool output exceeds maximum allowed tokens

The SDK applies the same MCP output limit as Claude Code. When a tool result is larger than 25,000 tokens, the full output is saved to a file and the tool result is replaced with an error message that names the file path, so the agent can read the output back in portions. Raise the limit with the [`MAX_MCP_OUTPUT_TOKENS`](/docs/en/env-vars) environment variable. See [MCP output limits and warnings](/docs/en/mcp#mcp-output-limits-and-warnings) for the full behavior, including how a server can declare a higher per-tool limit.

## Related resources

* **[Custom tools guide](/docs/en/agent-sdk/custom-tools)**: Build your own MCP server that runs in-process with your SDK application
* **[Permissions](/docs/en/agent-sdk/permissions)**: Control which MCP tools your agent can use with `allowedTools` and `disallowedTools`
* **[MCP output limits and warnings](/docs/en/mcp#mcp-output-limits-and-warnings)**: How the SDK handles tool results that exceed `MAX_MCP_OUTPUT_TOKENS`, including the persist-to-disk fallback and the `anthropic/maxResultSizeChars` per-tool annotation
* **[TypeScript SDK reference](/docs/en/agent-sdk/typescript)**: Full API reference including MCP configuration options
* **[Python SDK reference](/docs/en/agent-sdk/python)**: Full API reference including MCP configuration options
* **[MCP server directory](https://github.com/modelcontextprotocol/servers)**: Browse available MCP servers for databases, APIs, and more
