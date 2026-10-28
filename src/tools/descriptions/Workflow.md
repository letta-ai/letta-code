Execute a workflow script that orchestrates multiple subagents deterministically (loops, conditionals, fan-out) rather than model-driven.

Workflows run in the background: this tool returns immediately with a task ID, and a <task-notification> carrying the script's return value arrives when the workflow completes. Do not poll or sleep for it, and never fabricate the result before it arrives. TaskStop aborts the run. With `wait: true`, the workflow runs in the foreground instead and this tool returns the script's value directly.

Scripts that call `agent()` or `decide()` spend money on subagents and model calls. Run one only when the user explicitly asked for a workflow or multi-agent orchestration ("use a workflow", "fan out agents") or a skill's instructions call this tool; otherwise describe the workflow and ask first. For scripts that only call tools, use CodeMode instead.

Scripts can call tools directly: `await tools.<name>(args)` for this turn's built-in tools and `await tools.mcp__server__tool(args)` for the agent's MCP tools, subject to the user's permission rules. `await listTools()` returns `[{ name, description }]`; `await describeTool(name)` returns `{ name, description, inputSchema }`, or `undefined` for an unknown tool.

`await harness.load(agentId, { ref? })` returns typed views of an agent's memory at one revision. Each namespace has a synchronous `get(path)` (null if missing): `prompts` (root files compiled into the system prompt every turn: `{ name, description, body }`; the root `MEMORY.md` is `memory.get('')`, not a prompt), `memory` (the on-demand tree: `get('')` is the root and `get('reference')` returns a directory `{ body, files, directories }` whose `body` is its MEMORY.md; `get('reference/notes')` returns a file `{ name, description, body }`; paths have no `.md`), and `skills` (`get(name)` returns `{ description, body, files }`; `get('name/scripts/run.sh')` returns that file's text). `edit({ branch? })` returns an editor whose reads include its staged writes; each of its namespaces also has `put(path, value)` (replaces the node's own document, never its children; a new memory directory needs `{ directory: true, body }`), `update(path, fn)` (`fn` gets the staged value), and `delete(path, { recursive? })`, e.g. `e.memory.put('reference/notes', { description, body })`, `e.skills.put('name', { description, body })`, `e.prompts.update('persona', p => ({ ...p, body }))`. You write directory bodies, including links to children; `diff()` returns `{ changes, text, links }`, where `links` flags children a body doesn't link to and links that point nowhere. `commit(message?)` commits everything to a new branch (never main) based on the loaded revision and returns `{ sha, branch, base, changed, links }`. Editors also have `apply(changes)`, which replays changes (from another editor's `diff().changes` or `harness.diff`) onto the staged tree: a change applies when the node still matches its `before`, concurrent edits to one document merge line by line when they touch different lines, and the rest come back in `{ applied, merged, conflicts: [{ path, base, ours, theirs }] }` untouched. `harness.diff(agentId, { base, ref })` returns `{ base, ref, changes }` between two revisions; pass an edit's `base` and `branch` to read exactly what it changed. `harness.accept(agentId, ref, { expect })` moves main to `ref` only if main is still at `expect` and `ref` descends from it, and throws otherwise; to land concurrent edits, load main, `apply` each branch's changes, resolve conflicts, `commit`, then `accept(id, branch, { expect: e.base })`, reloading and retrying if main moved. Accepting your own main refreshes your system prompt. Reads and commits follow the same permission rules as file reads and writes. `swap(text, old, new, { all? })` replaces text and throws unless `old` matches exactly once.

Scripts are plain JavaScript and must begin with `export const meta = {...}`, a pure literal (no variables, calls, or interpolation). Pass the work list via `args`. Prefer `pipeline()` so each item moves to its next stage as soon as it is ready. Await `agent()` calls: failures reject with the cause, `callIndex`, and `conversationId` when available. `parallel()` and `pipeline()` let siblings finish, then reject if any callback failed; a failed pipeline item skips its remaining stages. Catch errors explicitly inside callbacks for best-effort processing.

  export const meta = {
    name: 'review-files',
    description: 'Review each file for bugs, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const findings = {type: 'object', properties: {bugs: {type: 'array', items: {type: 'string'}}}, required: ['bugs']}
  const verdict = {type: 'object', properties: {real: {type: 'boolean'}}, required: ['real']}
  const results = await pipeline(
    args.files,
    f => agent(`Review ${f} for bugs.`, { phase: 'Review', schema: findings }),
    (review, f) => parallel(review.bugs.map(bug => () =>
      agent(`Is this a real bug in ${f}? ${bug}`, { phase: 'Verify', schema: verdict })
        .then(v => v.real ? { file: f, bug } : null))),
  )
  return results.flat().filter(Boolean)

Before authoring a script, load the `workflow-authoring` skill — the script API, pipeline-vs-barrier rules, quality patterns, worked examples, and how to diagnose a run.
