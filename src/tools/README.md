# Client-side tool guidelines

How to implement tools that run locally in Letta Code.

## Contract
- Function signature: `(args, opts?) => Promise<{ toolReturn: string; status: "success" | "error"; stdout?: string[]; stderr?: string[] }>`
- Optional `opts.signal?: AbortSignal`. If you spawn a subprocess, wire this signal to it so Esc/abort can kill it cleanly. If you’re pure in-process, you can ignore it.

## Subprocess tools (e.g., Bash)
- Pass the provided `AbortSignal` to `exec`/`spawn` so abort kills the child. Normalize abort errors to `toolReturn: "User interrupted tool execution", status: "error"`.
- Avoid running multiple subprocesses unless you also expose a cancel hook; we execute tools serially to avoid races.

## In-process tools (read/write/edit)
- You can ignore the signal, but still return a clear `toolReturn` and `status`.
- Be deterministic and side-effect aware; the runner keeps tools serial to avoid file races.

## Errors
- Return a concise error message in `toolReturn` and set `status: "error"`.
- Don’t `console.error` from tools; the UI surfaces the returned message.
