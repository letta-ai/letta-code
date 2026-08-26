Use this tool to interact with MCP servers connected to the current Letta Cloud agent.

Commands:
- `list_servers`: returns the MCP servers associated with the current agent.
- `list_tools`: returns registered tools for one associated MCP server. Requires `mcp_server_id`.
- `run_tool`: runs a registered MCP tool through one associated MCP server. Requires `mcp_server_id`, `tool_id`, and optional `args`.

This tool is available only for signed-in Letta Cloud agents. It uses the current agent context automatically; do not pass an agent ID.
