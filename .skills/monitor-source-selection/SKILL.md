---
name: monitor-source-selection
description: How to choose between the Monitor tool's `command` and `script` sources in letta-code, and how each maps process output to events. Use when picking a monitor source for a watch or when explaining whether `script` adds monitoring capability beyond `command`.
metadata:
  status: proposed
  confidence: high
  evidence: '["letta:conv-fe4421b8-f7f6-4377-be10-07310b186547"]'
  rationale: 'Agents using Monitor can overstate `script` as a new monitoring capability or reduce the choice to a Bash-versus-JS tradeoff. The trajectory produced a command-vs-script selection split and an emit-vs-console.log distinction that the Monitor tool description does not state.'
---

# Monitor Source Selection

Pick the Monitor source by the shape of the watch, not by language:

- **`command`** — tailing logs, running an existing CLI or script, and piping shell utilities. It is not Bash-only: `command: 'node watch.js'` runs JS. Stdout is the event stream; stderr goes to the output file.
- **`script`** — repeatedly calling agent tools (`tools.*`) and comparing their results across polls. It is a prewired JavaScript environment that calls harness/MCP tools directly and reuses one MCP session for the watch instead of spawning a CLI per poll.

`script` is integration and convenience, not new capability: `command` can run the same JS, and `script` adds no restart persistence or automatic retries. Tool calls that require approval fail inside a script rather than prompting.

In `script`, only `emit(text)` sends events (through the same batching, rate suppression, and secret scrubbing as `command` stdout); `console.log` writes to the output file only. `sleep(ms)` is abortable, so TaskStop and timeout end a sleeping loop immediately. Returning ends the monitor as completed; throwing ends it as failed.

## Why this works / why it will be useful again

Future agents otherwise overstate `script` as a new monitoring capability or frame the choice as "JS versus Bash," which is wrong because `command` already runs JS. Keeping the selection split and the emit/console.log distinction available means watches are built with the right source and events are not silently lost to the output file.
