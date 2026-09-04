> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Troubleshoot the Agent SDK

> Fix Agent SDK errors by the exact message you see, with the cause and fix for each error in the TypeScript and Python SDKs.

Entries on this page are keyed to the error you see. Each names the cause and what to do.

## CLI startup

### CLINotFoundError: Claude Code not found

The Python SDK launches the Claude Code CLI as a subprocess. When it can't find a `claude` executable, connecting fails with a `CLINotFoundError`:

```
Claude Code not found at: /your/configured/path
```

The message includes the configured path when you set `ClaudeAgentOptions(cli_path=...)` and it points at a missing file. Without `cli_path`, the SDK searches your `PATH` and common install locations, and the message includes install instructions for your platform.

To fix it:

* Install Claude Code if it isn't installed. See [Install Claude Code](/docs/en/setup#install-claude-code) for the command on your platform.
* If you set `cli_path`, confirm the file exists and is the `claude` executable.
* If you rely on `PATH` resolution, confirm `claude --version` works in the same environment your application runs in. Processes you launch outside your shell, such as from an IDE or a service manager, often run with a different `PATH`.

The TypeScript SDK looks for the CLI in its bundled platform package and the path you set in `pathToClaudeCodeExecutable`. Match the message you see:

* `Native CLI binary for <platform>-<arch> not found`: the bundled platform package is missing, most often because the install skipped optional dependencies. Reinstall `@anthropic-ai/claude-agent-sdk` without skipping optional dependencies, or point `pathToClaudeCodeExecutable` at a [native install](/docs/en/setup#install-claude-code). In a single-file executable built with `bun build --compile`, the same message has a different cause and fix. See [Compile to a single executable](/docs/en/agent-sdk/typescript#compile-to-a-single-executable).
* `Claude Code native binary not found at <path>` or `Claude Code executable not found at <path>. Is options.pathToClaudeCodeExecutable set?`: the file at the resolved path is missing, or the process can't access it. Confirm the file exists at that path and that the process can access it.

### CLIConnectionError: Refusing to execute batch script

On Windows, connecting fails with a `CLIConnectionError` when the CLI path the Python SDK uses is a `.bat` or `.cmd` batch script, including the `claude.cmd` shim that an npm install creates:

```
Refusing to execute batch script 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd': Windows runs .bat/.cmd files via cmd.exe, which can execute commands injected through CLI arguments, and no reliable escaping for cmd.exe exists. Use a native claude executable instead: install Claude Code natively (irm https://claude.ai/install.ps1 | iex), point ClaudeAgentOptions(cli_path=...) at a claude.exe, or install the claude-agent-sdk wheel for a platform that bundles claude.exe (e.g. Windows x64).
```

The refusal is deliberate security hardening, not a broken install. Windows runs batch scripts by rewriting the spawn into a `cmd.exe /c` invocation, and `cmd.exe` re-parses the whole command line at execution time, so an argument value can execute injected commands.

Most Windows installs never reach this error. The Windows x64 wheel of `claude-agent-sdk` bundles a `claude.exe`, and the SDK prefers the bundled CLI, then any native `claude.exe` it can discover, before falling back to a batch shim. You see the refusal in two cases:

* You set `ClaudeAgentOptions(cli_path=...)` to a `.bat` or `.cmd` file, such as npm's `claude.cmd` shim.
* Your install has no bundled or native `claude.exe`, for example a source install on ARM64 Windows where the only `claude` on your `PATH` is the npm shim.

To fix it, give the SDK a native executable instead of a batch script:

* If you set `ClaudeAgentOptions(cli_path=...)`, point it at a `claude.exe` or remove the option. The SDK skips discovery while `cli_path` is set, so a native install alone can't take effect.
* Install Claude Code natively in PowerShell: `irm https://claude.ai/install.ps1 | iex`
* On x64 Windows, install the `claude-agent-sdk` wheel, which bundles `claude.exe`.

Before `claude-agent-sdk` 0.2.124, the Python SDK spawned batch scripts through `cmd.exe` without this check.

### CLIConnectionError: Failed to start Claude Code

The SDK found a file at the resolved path but couldn't launch it. Python raises these failures as a `CLIConnectionError`. TypeScript rejects the message iteration with an error carrying no SDK class. The table below maps each message to what it tells you. Match the message you see:

| Message                                                           | SDK        | What it tells you                                                    |
| ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| `Failed to start Claude Code: <detail>`                           | Python     | The rest of the message is the operating system's own error          |
| `Claude Code executable at <path> exists but failed to launch`    | TypeScript | The script at the configured path can't run                          |
| `Claude Code native binary at <path> exists but failed to launch` | TypeScript | The binary can't run, with a libc suggestion appended to the message |
| `Failed to spawn Claude Code process: <detail>`                   | TypeScript | Any other launch failure                                             |

In both SDKs, the usual cause is a resolved path that points at something that can't run, such as a text file, a directory, or a file without execute permission. Read the native-binary message's libc suggestion as one possible cause.

To fix it in either SDK:

* Confirm the configured path points at the `claude` executable itself and that the file has execute permission.
* If you don't need a custom path, remove `cli_path` in Python or `pathToClaudeCodeExecutable` in TypeScript so the SDK finds a CLI on its own, preferring its bundled copy.
* When the failing binary is the SDK's bundled copy in a container image, reinstall the SDK during the image build so the bundled binary matches the container's platform, or rebuild the image for the architecture it runs on. The usual cause is a binary that doesn't match the container's architecture or libc, or one that lost its execute permission in the image build.

### CLIConnectionError: Not connected

Calling a `ClaudeSDKClient` method in Python before the client has connected, or after it has disconnected, raises a `CLIConnectionError` with this message:

```
Not connected. Call connect() first.
```

Do what the message says. Either call `await client.connect()` before any other client method, or open the client with `async with ClaudeSDKClient() as client:`, which connects on entry.

## CLI process exit

The entries in this section mean the Claude Code process ended while your application was using it. Which error you see depends on the SDK language and on whether the CLI reported an error result before it exited.

### ProcessError: Command failed with exit code

The Python SDK raises a `ProcessError` when the Claude Code process exits with a nonzero code:

```
Command failed with exit code 1 (exit code: 1)
Error output: Check stderr output for details
```

The message states the exit code twice, and the `Error output` line is fixed text rather than your process's error output. The same fixed text fills the exception's `stderr` attribute. The exception's `exit_code` attribute carries the code. To capture what the CLI actually wrote to stderr, pass a `stderr` callback in `ClaudeAgentOptions` and log what it receives.

A bare `ProcessError` means the CLI exited without reporting an error result. When the CLI did report one, the SDK raises [`ResultError`](/docs/en/agent-sdk/python#resulterror) instead, covered in [Claude Code returned an error result](#claude-code-returned-an-error-result). `ResultError` subclasses `ProcessError`, so `except ProcessError` catches both. To handle them differently, put the `except ResultError` clause first.

Before `claude-agent-sdk` 0.2.140, the Python SDK raised error-result exits as a plain `Exception` rather than a `ResultError`.

### Claude Code process exited with code N

IDE wrappers print this message too, and the [error reference](/docs/en/errors#claude-code-process-exited-with-code-n) covers it for VS Code and other launchers. This entry covers what your TypeScript SDK code receives. The SDK surfaces a nonzero CLI exit as a plain `Error` that rejects the `for await` loop over `query()`'s messages. There's no SDK error class to catch, so wrap the loop in `try`/`catch` and match on the message:

```
Claude Code process exited with code 1. stderr: <tail of the CLI's stderr>
```

When the CLI wrote to stderr, the message ends with the tail of it. To capture the full stream, pass a `stderr` callback in the query options. A process killed by a signal reports `Claude Code process terminated by signal <name>` in the same form.

### Claude Code returned an error result

Both SDKs replace the process-exit error with this message when the CLI reported an error result before exiting:

```
Claude Code returned an error result: <the CLI's own error report>
```

The text after the colon is the CLI's report of what went wrong, so start there rather than with the exit itself. Python raises this as a [`ResultError`](/docs/en/agent-sdk/python#resulterror), whose `data` attribute carries the full error result. TypeScript rejects the message loop with a plain `Error` carrying the same message shape.

## Structured outputs

### structured\_output is None but the result says success

A result message can end with `subtype: "success"` while `structured_output` is `None` in Python or `undefined` in TypeScript. The run completes, but no validated output exists. One way to hit this is a schema no output can satisfy, for example conflicting length constraints. The run ends without a validation error, and the only signal is the missing `structured_output`.

Treat this result as a failure in application code. Check both that `subtype` is `success` and that `structured_output` is present before using it. The [Error handling](/docs/en/agent-sdk/structured-outputs#error-handling) section shows this pattern for both SDKs.

If it happens repeatedly with a schema you believe is correct, verify the schema is satisfiable, then simplify it until outputs validate, and reintroduce constraints one at a time.

## Report a new issue

If your error isn't covered here, check the open issues or file a new one in the SDK repositories: [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues) or [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python/issues). Include the full error text and your SDK version.
