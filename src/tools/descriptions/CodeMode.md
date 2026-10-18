Run a JavaScript async function body that calls tools and returns only the results you need.

Call built-in tools with `await tools.<name>(args)` and MCP tools with `await tools.mcp__server__tool(args)`; `listTools()` and `describeTool(name)` list tools and their schemas. Failed calls throw. `args` holds optional input, and `console.log()` output is captured. Scripts cannot call models or spawn subagents; use Workflow for that.

Returns `{ result, output }`. Like Bash, a script still running after a brief wait continues in the background and its result arrives as a task notification; `run_in_background: true` returns the task ID immediately. TaskStop aborts it.

Nested calls follow permission rules; calls that need approval fail, so call those tools directly. This is not a security sandbox.

Example:

    const texts = await Promise.all(args.paths.map(file_path => tools.Read({ file_path })));
    return texts.map((text, i) => ({ path: args.paths[i], lines: text.split('\n').length }));
