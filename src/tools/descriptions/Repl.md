Run JavaScript in a persistent session that lasts for this conversation. Use it to call tools programmatically and to start subagent workers that you can steer, pause, and resume from later cells.

A cell is an async function body: use `await`, and `return` the value you want to see. Variables created by bare assignment (`w = ...` or `globalThis.w = ...`) persist across cells; `const`/`let` stay local to the cell.

Globals:
- `tools.<name>(args)` calls a built-in tool and `tools.mcp__server__tool(args)` calls an MCP tool; `listTools()` and `describeTool(name)` list them. Failed calls throw. Calls follow permission rules; calls that need approval fail, so call those tools directly.
- `agent(prompt, opts?)` runs a worker and resolves to its final reply.
- `agent.start(prompt, opts?)` returns a worker handle immediately: `w.send(msg)` interrupts the current turn and continues the worker's conversation with `msg` (`{ interrupt: false }` queues it instead); `w.pause()` interrupts and holds; `w.resume(msg?)` continues; `w.interrupt()` stops the current turn; `w.stop()` closes the worker; `w.result()` resolves to the latest reply once nothing is running or queued; `w.info()` reports `{ id, status, conversationId, turns, lastResult, lastError }`.
- `agent.get(id)` returns a worker by id, label, or conversation ID; `agent.list()` lists all workers.
- `parallel(thunks)`, `pipeline(items, ...stages)`, `args`, and `console.log()` (captured as output).

Worker options: `label`, `model`, `effort`, `allowedTools`, `systemPrompt`, `skills`, `json`, `schema`, `timeoutMs`, `maxToolCalls`, and `conversationId` to continue an existing worker conversation. Model, effort, system prompt, and skills are fixed when the worker starts.

Workers belong to the session, not the cell: they keep running after the cell returns or is stopped. When a worker finishes while no cell is running, you receive a task notification. `reset: true` stops every worker and clears the session.

Returns `{ result, output, workers }`. A cell still running after a brief wait continues in the background and its result arrives as a task notification; TaskStop stops the cell. This is not a security sandbox.

Example:

    reviewer = agent.start("Review src/auth.ts for security bugs.", { label: "auth review" });
    return reviewer.info();

Later cell:

    return await reviewer.send("Also check the session cookie flags, then summarize.");
