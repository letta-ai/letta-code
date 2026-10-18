Run a JavaScript script that combines tools and returns only the results you need.

The tool returns `{ result, output }`. Like Bash, a script still running after a brief wait continues in the background: the tool returns a task ID, and a <task-notification> carrying `{ result, output }` arrives when it finishes. Do not poll or sleep for it; TaskStop aborts it. Set `run_in_background: true` to return the task ID immediately.

Use `await tools.<name>(args)` for this turn's built-in tools and `await tools.mcp__server__tool(args)` for the agent's MCP tools. `await listTools()` returns names and descriptions; `await describeTool(name)` returns its input schema. Built-ins return text; MCP calls return structured content when available, otherwise text (parsed when JSON) or content blocks. Failed calls throw; catch errors or use `Promise.allSettled()` to keep successful results.

`code` is a plain JavaScript async function body: top-level `await`, `return`, `console.log()`, and `Promise.all()` work. Optional `args` supplies input data. No metadata header or imports are needed. Scripts cannot spawn subagents or call models; use Workflow for that. Agent, Workflow, CodeMode, SendAgentMessage, and AskUserQuestion are not callable. Await every tool call. Calls share a concurrency limit of 16 and a lifetime limit of 1000.

Each call checks the user's permission rules. Calls needing approval fail closed: call the tool directly to request approval. Scripts run with the CLI's privileges, like Workflow; this is not a security sandbox. Use tools for external operations.

Example:

    const results = await Promise.all(args.paths.map(file_path => tools.Read({ file_path })));
    return results.map((text, i) => ({ path: args.paths[i], lines: text.split('\n').length }));
