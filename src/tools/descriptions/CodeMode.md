Run a JavaScript async function body that calls tools and returns only the results you need.

Call built-in tools with `await tools.<name>(args)` and MCP tools with `await tools.mcp__server__tool(args)`; `listTools()` and `describeTool(name)` list tools and their schemas. Failed calls throw. `args` holds optional input, and `console.log()` output is captured. Scripts cannot call models or spawn subagents; use Workflow for that.

`memory.open(path | { agentId } | { repoId })` opens a Git-backed memory repository: `read(path, { ref? })` (null if missing), `list({ path?, ref? })`, `log({ path?, ref?, limit? })`, `diff({ ref, base? })`, and `commit({ message, branch?, base? }).put(path, text).delete(path).send()`. Commits run the repository's memory validation, follow permission rules like file writes, and default to the repository's main branch; a new `branch` is created from `base`. Committing to your own hosted memory's main branch refreshes your system prompt.

Returns `{ result, output }`. Like Bash, a script still running after a brief wait continues in the background and its result arrives as a task notification; `run_in_background: true` returns the task ID immediately. TaskStop aborts it.

Nested calls follow permission rules; calls that need approval fail, so call those tools directly. This is not a security sandbox.

Example:

    const texts = await Promise.all(args.paths.map(file_path => tools.Read({ file_path })));
    return texts.map((text, i) => ({ path: args.paths[i], lines: text.split('\n').length }));
