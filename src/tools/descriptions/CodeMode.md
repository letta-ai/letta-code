Run a JavaScript async function body that calls tools and returns only the results you need.

Call built-in and server-side tools with `await tools.<name>(args)` and MCP tools with `await tools.mcp__server__tool(args)`; `listTools()` and `describeTool(name)` list tools and their schemas. Failed calls throw. `args` holds optional input, `process.env` holds the variables a shell command sees plus the agent's secrets, and `console.log()` output is captured.

`await decide(state, questions, options?)` makes one typed model decision. `questions` is an object of id → `{ type, instructions, criteria }`: `choice` takes a criteria map of id → description, `score` a criteria array, `noul` no criteria. It resolves to `{ answers }` keyed by question id (`.choice`, `.score`, or `.noul` in 0–1), or `null` after an invalid answer.

Returns `{ result, output }`. Like a shell command, a script still running after a brief wait continues in the background and its result arrives as a task notification; `run_in_background: true` returns the task ID immediately. TaskStop aborts it.

Nested calls follow permission rules; calls that need approval fail, so call those tools directly. This is not a security sandbox.
